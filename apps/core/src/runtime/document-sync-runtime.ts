import { createClient } from "redis";
import type pg from "pg";

import {
  readDocumentSyncWorkerRuntimeConfig,
  readFeishuOpenApiConfig,
  type DocumentSyncWorkerRuntimeConfig,
  type EnvLike,
} from "../config/env.js";
import { readDatabaseConfig, type DatabaseConfig } from "../database/database-config.js";
import { createPostgresPool } from "../database/postgres.js";
import { createFeishuDocumentBodyFetcher } from "../documents/feishu-document-body-fetcher.js";
import {
  createDocumentSyncRunner,
  type DocumentBodyFetcher,
  type DocumentSyncRunner,
  type DocumentSyncRunnerRegistry,
  type DocumentSyncSnapshotWriter,
} from "../documents/document-sync-pipeline.js";
import type { DocumentSyncQueue } from "../documents/document-sync-queue.js";
import { createDocumentSyncWorker } from "../documents/document-sync-worker.js";
import {
  createDocumentSyncWorkerLoop,
  type DocumentSyncWorkerBatchSnapshot,
  type DocumentSyncWorkerLoop,
} from "../documents/document-sync-worker-loop.js";
import {
  createDocumentSnapshotRepository,
  type Queryable,
} from "../documents/document-snapshot-repository.js";
import { createPostgresDocumentSourceRegistry } from "../documents/postgres-document-source-registry.js";
import {
  createRedisDocumentSyncQueue,
  type RedisDocumentSyncQueueClient,
} from "../documents/redis-document-sync-queue.js";
import {
  createFeishuTenantAccessTokenProvider,
  type FeishuTenantAccessTokenProvider,
} from "../feishu/feishu-tenant-access-token-provider.js";

export type DocumentSyncRuntime = {
  getStatus(): Promise<DocumentSyncRuntimeStatus>;
  start(): void;
  close(): Promise<void>;
};

export type DocumentSyncRuntimeStatus = {
  enabled: true;
  running: boolean;
  intervalMs: number;
  batchLimit: number;
  pendingJobCount: number;
  latestBatch?: DocumentSyncWorkerBatchSnapshot;
};

type PostgresPool = Queryable & { end(): Promise<void> };
type DocumentSyncRuntimeQueue = Pick<DocumentSyncQueue, "dequeueBatch" | "getPendingCount">;
type RedisClient = RedisDocumentSyncQueueClient & {
  connect(): Promise<unknown>;
  quit(): Promise<unknown>;
};

export type DocumentSyncRuntimeDependencies = {
  createPostgresPool?: (config: DatabaseConfig) => PostgresPool;
  createRedisClient?: (url: string) => RedisClient;
  createDocumentSourceRegistry?: (pool: PostgresPool) => DocumentSyncRunnerRegistry;
  createDocumentSnapshotRepository?: (dependencies: {
    queryable: Queryable;
  }) => DocumentSyncSnapshotWriter;
  createFeishuTenantAccessTokenProvider?: (dependencies: {
    baseUrl: string;
    appId: string;
    appSecret: string;
  }) => FeishuTenantAccessTokenProvider;
  createFeishuDocumentBodyFetcher?: (dependencies: {
    baseUrl: string;
    tokenProvider: FeishuTenantAccessTokenProvider;
  }) => DocumentBodyFetcher;
  createDocumentSyncQueue?: (client: RedisDocumentSyncQueueClient) => DocumentSyncRuntimeQueue;
  createDocumentSyncRunner?: typeof createDocumentSyncRunner;
  createDocumentSyncWorker?: typeof createDocumentSyncWorker;
  createWorkerLoop?: typeof createDocumentSyncWorkerLoop;
};

export function createDocumentSyncRuntime({
  env = process.env,
  dependencies = {},
}: {
  env?: EnvLike;
  dependencies?: DocumentSyncRuntimeDependencies;
} = {}): DocumentSyncRuntime | undefined {
  const runtimeConfig = readDocumentSyncWorkerRuntimeConfig(env);
  if (!runtimeConfig.enabled) {
    return undefined;
  }

  return createEnabledDocumentSyncRuntime({ env, runtimeConfig, dependencies });
}

function createEnabledDocumentSyncRuntime({
  env,
  runtimeConfig,
  dependencies,
}: {
  env: EnvLike;
  runtimeConfig: Extract<DocumentSyncWorkerRuntimeConfig, { enabled: true }>;
  dependencies: DocumentSyncRuntimeDependencies;
}): DocumentSyncRuntime {
  const createPool = dependencies.createPostgresPool ?? createPostgresPool;
  const createRedis =
    dependencies.createRedisClient ??
    ((url: string) => createClient({ url }) as unknown as RedisClient);
  const createDocumentSources =
    dependencies.createDocumentSourceRegistry ?? createDefaultDocumentSourceRegistry;
  const createSnapshots =
    dependencies.createDocumentSnapshotRepository ?? createDocumentSnapshotRepository;
  const createTokenProvider =
    dependencies.createFeishuTenantAccessTokenProvider ?? createFeishuTenantAccessTokenProvider;
  const createBodyFetcher =
    dependencies.createFeishuDocumentBodyFetcher ?? createFeishuDocumentBodyFetcher;
  const createQueue =
    dependencies.createDocumentSyncQueue ??
    ((client: RedisDocumentSyncQueueClient) => createRedisDocumentSyncQueue({ client }));
  const createRunner = dependencies.createDocumentSyncRunner ?? createDocumentSyncRunner;
  const createWorker = dependencies.createDocumentSyncWorker ?? createDocumentSyncWorker;
  const createLoop = dependencies.createWorkerLoop ?? createDocumentSyncWorkerLoop;

  const feishuConfig = readFeishuOpenApiConfig(env);
  const pool = createPool(readDatabaseConfig(env));
  const redis = createRedis(runtimeConfig.redisUrl);
  const redisConnection = redis.connect().then(() => redis);
  const documentSources = createDocumentSources(pool);
  const snapshots = createSnapshots({ queryable: pool });
  const tokenProvider = createTokenProvider({
    baseUrl: feishuConfig.baseUrl,
    appId: feishuConfig.appId,
    appSecret: feishuConfig.appSecret,
  });
  const fetcher = createBodyFetcher({
    baseUrl: feishuConfig.baseUrl,
    tokenProvider,
  });
  const queue = createQueue(createLazyRedisDocumentSyncQueueClient(redisConnection));
  const runner: DocumentSyncRunner = createRunner({
    registry: documentSources,
    snapshots,
    fetcher,
  });
  const worker = createWorker({
    queue,
    runner,
  });
  const loop: DocumentSyncWorkerLoop = createLoop({
    worker,
    intervalMs: runtimeConfig.intervalMs,
    batchLimit: runtimeConfig.batchLimit,
    onError: () => undefined,
  });

  return {
    start() {
      loop.start();
    },
    async getStatus() {
      const loopSnapshot = loop.getSnapshot();
      const pendingJobCount = await queue.getPendingCount();

      return {
        enabled: true,
        running: loopSnapshot.running,
        intervalMs: loopSnapshot.intervalMs,
        batchLimit: loopSnapshot.batchLimit,
        pendingJobCount,
        ...(loopSnapshot.latestBatch === undefined
          ? {}
          : { latestBatch: loopSnapshot.latestBatch }),
      };
    },
    async close() {
      await loop.stop();
      await redisConnection.then((client) => client.quit());
      await pool.end();
    },
  };
}

function createDefaultDocumentSourceRegistry(pool: PostgresPool): DocumentSyncRunnerRegistry {
  return createPostgresDocumentSourceRegistry(pool as unknown as pg.Pool);
}

function createLazyRedisDocumentSyncQueueClient(
  redisConnection: Promise<RedisClient>,
): RedisDocumentSyncQueueClient {
  return {
    async eval(script, options) {
      const client = await redisConnection;
      return client.eval(script, options);
    },
    async lPop(key) {
      const client = await redisConnection;
      return client.lPop(key);
    },
    async lLen(key) {
      const client = await redisConnection;
      return client.lLen(key);
    },
  };
}
