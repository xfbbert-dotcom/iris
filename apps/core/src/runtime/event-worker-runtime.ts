import { createClient } from "redis";
import type pg from "pg";

import {
  readEventWorkerRuntimeConfig,
  type EnvLike,
  type EventWorkerRuntimeConfig,
} from "../config/env.js";
import { createFeishuMessageEventProcessor } from "../conversation/feishu-message-event-processor.js";
import {
  createPostgresConversationMessageRepository,
  type Queryable,
} from "../conversation/postgres-conversation-message-repository.js";
import { readDatabaseConfig, type DatabaseConfig } from "../database/database-config.js";
import { createPostgresPool } from "../database/postgres.js";
import { createDiscoveredDocumentSyncPlanner } from "../documents/discovered-document-sync-planner.js";
import type { DocumentSyncQueue } from "../documents/document-sync-queue.js";
import { createFeishuDocumentLinkExtractor } from "../documents/feishu-document-link-extractor.js";
import { createGroupVisibleDocumentRegistrar } from "../documents/group-visible-document-registrar.js";
import {
  createPostgresDocumentSourceRegistry,
  type AsyncDocumentSourceRegistry,
} from "../documents/postgres-document-source-registry.js";
import {
  createRedisDocumentSyncQueue,
  type RedisDocumentSyncQueueClient,
} from "../documents/redis-document-sync-queue.js";
import { createRedisRawEventQueue, type RedisRawEventQueueClient } from "../events/redis-raw-event-queue.js";
import type { RawEventQueue } from "../events/raw-event-queue.js";
import { createRawEventWorker } from "../events/raw-event-worker.js";
import {
  createRawEventWorkerLoop,
  type RawEventWorkerBatchSnapshot,
  type RawEventWorkerLoop,
} from "../events/raw-event-worker-loop.js";

export type EventWorkerRuntime = {
  rawEventQueue?: Pick<RawEventQueue, "enqueue">;
  getStatus(): Promise<EventWorkerRuntimeStatus>;
  start(): void;
  close(): Promise<void>;
};

export type EventWorkerRuntimeStatus = {
  enabled: true;
  running: boolean;
  intervalMs: number;
  batchLimit: number;
  pendingEventCount: number;
  deadLetterEventCount: number;
  latestBatch?: RawEventWorkerBatchSnapshot;
};

type RedisClient = RedisRawEventQueueClient & RedisDocumentSyncQueueClient & {
  connect(): Promise<unknown>;
  quit(): Promise<unknown>;
};
type PostgresPool = Queryable & { end(): Promise<void> };
type RuntimeGate = {
  canProcessIncomingEvent(input: { groupId?: string }): boolean;
  canReadGroupContext(groupId: string): boolean;
  canReadDocuments(): boolean;
};
type GroupVisibleDocumentRegistry = Pick<
  AsyncDocumentSourceRegistry,
  "registerGroupVisibleDocument"
>;

export type EventWorkerRuntimeDependencies = {
  createPostgresPool?: (config: DatabaseConfig) => PostgresPool;
  createRedisClient?: (url: string) => RedisClient;
  createConversationMessageRepository?: typeof createPostgresConversationMessageRepository;
  createDocumentSourceRegistry?: (pool: PostgresPool) => GroupVisibleDocumentRegistry;
  createDocumentLinkExtractor?: typeof createFeishuDocumentLinkExtractor;
  createDocumentSyncQueue?: (
    client: RedisDocumentSyncQueueClient,
  ) => Pick<DocumentSyncQueue, "enqueue">;
  createDiscoveredDocumentSyncPlanner?: typeof createDiscoveredDocumentSyncPlanner;
  createGroupVisibleDocumentRegistrar?: typeof createGroupVisibleDocumentRegistrar;
  createProcessor?: typeof createFeishuMessageEventProcessor;
  createWorkerLoop?: typeof createRawEventWorkerLoop;
};

export function createEventWorkerRuntime({
  env = process.env,
  dependencies = {},
  runtimeController,
}: {
  env?: EnvLike;
  dependencies?: EventWorkerRuntimeDependencies;
  runtimeController?: RuntimeGate;
} = {}): EventWorkerRuntime | undefined {
  const runtimeConfig = readEventWorkerRuntimeConfig(env);
  if (!runtimeConfig.enabled) {
    return undefined;
  }

  return createEnabledEventWorkerRuntime({ env, runtimeConfig, dependencies, runtimeController });
}

function createEnabledEventWorkerRuntime({
  env,
  runtimeConfig,
  dependencies,
  runtimeController,
}: {
  env: EnvLike;
  runtimeConfig: Extract<EventWorkerRuntimeConfig, { enabled: true }>;
  dependencies: EventWorkerRuntimeDependencies;
  runtimeController: RuntimeGate | undefined;
}): EventWorkerRuntime {
  const createRedis =
    dependencies.createRedisClient ??
    ((url: string) => createClient({ url }) as unknown as RedisClient);
  const createPool = dependencies.createPostgresPool ?? createPostgresPool;
  const createMessages =
    dependencies.createConversationMessageRepository ??
    createPostgresConversationMessageRepository;
  const createDocumentSources =
    dependencies.createDocumentSourceRegistry ?? createDefaultDocumentSourceRegistry;
  const createDocumentLinkExtractor =
    dependencies.createDocumentLinkExtractor ?? createFeishuDocumentLinkExtractor;
  const createDocumentSyncQueue =
    dependencies.createDocumentSyncQueue ??
    ((client: RedisDocumentSyncQueueClient) => createRedisDocumentSyncQueue({ client }));
  const createDiscoveredSyncPlanner =
    dependencies.createDiscoveredDocumentSyncPlanner ?? createDiscoveredDocumentSyncPlanner;
  const createGroupVisibleRegistrar =
    dependencies.createGroupVisibleDocumentRegistrar ?? createGroupVisibleDocumentRegistrar;
  const createProcessor = dependencies.createProcessor ?? createFeishuMessageEventProcessor;
  const createLoop = dependencies.createWorkerLoop ?? createRawEventWorkerLoop;

  const pool = createPool(readDatabaseConfig(env));
  const redis = createRedis(runtimeConfig.redisUrl);
  const redisConnection = redis.connect().then(() => redis);
  const messages = createMessages({ queryable: pool });
  const documentSources = createDocumentSources(pool);
  const documentLinkExtractor = createDocumentLinkExtractor();
  const documentSyncQueue = createDocumentSyncQueue(
    createLazyRedisDocumentSyncQueueClient(redisConnection),
  );
  const syncPlanner = createDiscoveredSyncPlanner({ queue: documentSyncQueue });
  const groupVisibleDocumentRegistrar = createGroupVisibleRegistrar({
    registry: documentSources,
    syncPlanner,
  });
  const processor = createProcessor({
    messages,
    documentLinkExtractor,
    groupVisibleDocumentRegistrar,
    ...(runtimeController === undefined ? {} : { runtimeController }),
  });
  const queue = createRedisRawEventQueue({
    client: createLazyRedisQueueClient(redisConnection),
  });
  const worker = createRawEventWorker({
    queue,
    processor,
  });
  const loop: RawEventWorkerLoop = createLoop({
    worker,
    intervalMs: runtimeConfig.intervalMs,
    batchLimit: runtimeConfig.batchLimit,
    onError: () => undefined,
  });

  return {
    rawEventQueue: queue,
    start() {
      loop.start();
    },
    async getStatus() {
      const loopSnapshot = loop.getSnapshot();
      const pendingEventCount = await queue.getPendingCount();
      const deadLetterEventCount = await queue.getDeadLetterCount();

      return {
        enabled: true,
        running: loopSnapshot.running,
        intervalMs: loopSnapshot.intervalMs,
        batchLimit: loopSnapshot.batchLimit,
        pendingEventCount,
        deadLetterEventCount,
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

function createDefaultDocumentSourceRegistry(pool: PostgresPool): GroupVisibleDocumentRegistry {
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
    async rPush(key, value) {
      const client = await redisConnection;
      return client.rPush(key, value);
    },
    async lPop(key) {
      const client = await redisConnection;
      return client.lPop(key);
    },
    async lLen(key) {
      const client = await redisConnection;
      return client.lLen(key);
    },
    async lRange(key, start, stop) {
      const client = await redisConnection;
      return client.lRange(key, start, stop);
    },
    async lRem(key, count, value) {
      const client = await redisConnection;
      return client.lRem(key, count, value);
    },
  };
}

function createLazyRedisQueueClient(
  redisConnection: Promise<RedisClient>,
): RedisRawEventQueueClient {
  return {
    async eval(script, options) {
      const client = await redisConnection;
      return client.eval(script, options);
    },
    async rPush(key, value) {
      const client = await redisConnection;
      return client.rPush(key, value);
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
