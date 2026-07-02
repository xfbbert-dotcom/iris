import { createClient } from "redis";
import type pg from "pg";

import {
  readEmbeddingProviderConfig,
  readDocumentSyncWorkerRuntimeConfig,
  readFeishuOpenApiConfig,
  type DocumentSyncWorkerRuntimeConfig,
  type EmbeddingProviderConfig,
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
import type {
  DocumentSyncDeadLetter,
  DocumentSyncQueue,
  ReplayDocumentSyncDeadLettersResult,
} from "../documents/document-sync-queue.js";
import { createDocumentSyncWorker } from "../documents/document-sync-worker.js";
import {
  createDocumentSyncWorkerLoop,
  type DocumentSyncWorkerBatchSnapshot,
  type DocumentSyncWorkerLoop,
} from "../documents/document-sync-worker-loop.js";
import {
  createDocumentSnapshotRepository,
  type DocumentSnapshot,
  type Queryable,
} from "../documents/document-snapshot-repository.js";
import {
  createManualDocumentSyncPlanner,
  type ManualDocumentSyncEnqueueResult,
  type ManualDocumentSyncPlanner,
} from "../documents/manual-document-sync-planner.js";
import {
  createPostgresDocumentSourceRegistry,
  type AsyncDocumentSourceRegistry,
} from "../documents/postgres-document-source-registry.js";
import type {
  DocumentSource,
  DocumentSourceType,
} from "../documents/document-source-registry.js";
import {
  createRedisDocumentSyncQueue,
  type RedisDocumentSyncQueueClient,
} from "../documents/redis-document-sync-queue.js";
import {
  createFeishuTenantAccessTokenProvider,
  type FeishuTenantAccessTokenProvider,
} from "../feishu/feishu-tenant-access-token-provider.js";
import {
  assertSupportedRuntimeEmbeddingDimension,
  createEmbeddingProfileId,
} from "../model/embedding-profile-id.js";
import { createDocumentReindexPlanner } from "../reindex/document-reindex-planner.js";
import type { DocumentReindexQueue } from "../reindex/document-reindex-queue.js";
import {
  createRedisDocumentReindexQueue,
  type RedisDocumentReindexQueueClient,
} from "../reindex/redis-document-reindex-queue.js";

export type DocumentSyncRuntime = {
  getStatus(): Promise<DocumentSyncRuntimeStatus>;
  sources: {
    list(input: DocumentSourceInventoryListInput): Promise<DocumentSource[]>;
    get(id: string): Promise<DocumentSource | undefined>;
    updatePolicy(input: DocumentSourcePolicyUpdateInput): Promise<DocumentSource | undefined>;
    listSnapshots(input: DocumentSourceSnapshotListInput): Promise<DocumentSnapshot[] | undefined>;
  };
  enqueueSource(input: { documentSourceId: string }): Promise<ManualDocumentSyncEnqueueResult>;
  registerAuthorizedWikiDocument(
    input: Parameters<AsyncDocumentSourceRegistry["registerAuthorizedWikiDocument"]>[0],
  ): Promise<{
    source: Awaited<ReturnType<AsyncDocumentSourceRegistry["registerAuthorizedWikiDocument"]>>;
    enqueue: ManualDocumentSyncEnqueueResult;
  }>;
  registerUserSubmittedDocument(
    input: Parameters<AsyncDocumentSourceRegistry["registerUserSubmittedDocument"]>[0],
  ): Promise<{
    source: Awaited<ReturnType<AsyncDocumentSourceRegistry["registerUserSubmittedDocument"]>>;
    enqueue: ManualDocumentSyncEnqueueResult;
  }>;
  deadLetters: {
    list(input: { limit: number }): Promise<DocumentSyncDeadLetter[]>;
    replay(id: string): Promise<"replayed" | "not_found" | "unsupported_legacy_item">;
    delete(id: string): Promise<"deleted" | "not_found" | "unsupported_legacy_item">;
    replayBatch(input: { ids: string[] }): Promise<ReplayDocumentSyncDeadLettersResult>;
  };
  start(): void;
  close(): Promise<void>;
};

export type DocumentSourceInventoryListInput = {
  limit: number;
  sourceType?: DocumentSourceType;
  groupId?: string;
  authorizedSpaceId?: string;
  submittedByUserId?: string;
  usableForAnswering?: true;
};

export type DocumentSourcePolicyUpdateInput = {
  id: string;
  canUseForAnswering?: boolean;
  canUseForKnowledgeDrafts?: boolean;
};

export type DocumentSourceSnapshotListInput = {
  id: string;
  limit: number;
};

export type DocumentSyncRuntimeStatus = {
  enabled: true;
  running: boolean;
  intervalMs: number;
  batchLimit: number;
  pendingJobCount: number;
  deadLetterJobCount: number;
  latestBatch?: DocumentSyncWorkerBatchSnapshot;
};

type PostgresPool = Queryable & { end(): Promise<void> };
type DocumentSyncRuntimeSnapshots = DocumentSyncSnapshotWriter & {
  listSnapshotsForSource(documentSourceId: string): Promise<DocumentSnapshot[]>;
  listSuccessfulSnapshotsMissingProfile(input: {
    embeddingProfileId: string;
    limit: number;
  }): Promise<DocumentSnapshot[]>;
};
type DocumentSyncRuntimeDocumentSources = DocumentSyncRunnerRegistry &
  Pick<
    AsyncDocumentSourceRegistry,
    | "registerAuthorizedWikiDocument"
    | "registerUserSubmittedDocument"
    | "listSources"
    | "listSourcesByType"
    | "listSourcesByGroupId"
    | "listSourcesByAuthorizedSpaceId"
    | "listSourcesBySubmittingUserId"
    | "listSourcesUsableForAnswering"
    | "setAnsweringEnabled"
    | "setKnowledgeDraftsEnabled"
  >;
type DocumentSyncRuntimeQueue = Pick<
  DocumentSyncQueue,
  | "dequeueBatch"
  | "enqueue"
  | "getPendingCount"
  | "handleFailedJob"
  | "getDeadLetterCount"
  | "listDeadLetters"
  | "replayDeadLetter"
  | "deleteDeadLetter"
  | "replayDeadLetters"
>;
type DocumentSyncRuntimeReindexQueue = Pick<DocumentReindexQueue, "enqueue">;
type DocumentSyncRuntimeReindexPlanner = Pick<
  ReturnType<typeof createDocumentReindexPlanner>,
  "enqueueSyncedSnapshotReindex"
>;
type RedisClient = RedisDocumentSyncQueueClient &
  RedisDocumentReindexQueueClient & {
  connect(): Promise<unknown>;
  quit(): Promise<unknown>;
};

export type DocumentSyncRuntimeDependencies = {
  createPostgresPool?: (config: DatabaseConfig) => PostgresPool;
  createRedisClient?: (url: string) => RedisClient;
  createDocumentSourceRegistry?: (pool: PostgresPool) => DocumentSyncRuntimeDocumentSources;
  createDocumentSnapshotRepository?: (dependencies: {
    queryable: Queryable;
  }) => DocumentSyncRuntimeSnapshots;
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
  createDocumentReindexQueue?: (
    client: RedisDocumentReindexQueueClient,
  ) => DocumentSyncRuntimeReindexQueue;
  createDocumentReindexPlanner?: (
    dependencies: Parameters<typeof createDocumentReindexPlanner>[0],
  ) => DocumentSyncRuntimeReindexPlanner;
  createManualDocumentSyncPlanner?: (
    dependencies: Parameters<typeof createManualDocumentSyncPlanner>[0],
  ) => ManualDocumentSyncPlanner;
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
  const createReindexQueue =
    dependencies.createDocumentReindexQueue ??
    ((client: RedisDocumentReindexQueueClient) => createRedisDocumentReindexQueue({ client }));
  const createReindexPlanner =
    dependencies.createDocumentReindexPlanner ?? createDocumentReindexPlanner;
  const createManualPlanner =
    dependencies.createManualDocumentSyncPlanner ?? createManualDocumentSyncPlanner;
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
  const manualPlanner = createManualPlanner({
    registry: documentSources,
    queue,
  });
  const syncedSnapshotReindexer = createSyncedSnapshotReindexer({
    embeddingConfig: readEmbeddingProviderConfig(env),
    createReindexQueue,
    createReindexPlanner,
    snapshots,
    redisConnection,
  });
  const runner: DocumentSyncRunner = createRunner({
    registry: documentSources,
    snapshots,
    fetcher,
    ...(syncedSnapshotReindexer === undefined ? {} : { syncedSnapshotReindexer }),
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
      const deadLetterJobCount = await queue.getDeadLetterCount();

      return {
        enabled: true,
        running: loopSnapshot.running,
        intervalMs: loopSnapshot.intervalMs,
        batchLimit: loopSnapshot.batchLimit,
        pendingJobCount,
        deadLetterJobCount,
        ...(loopSnapshot.latestBatch === undefined
          ? {}
          : { latestBatch: loopSnapshot.latestBatch }),
      };
    },
    enqueueSource(input) {
      return manualPlanner.enqueueSource(input);
    },
    sources: {
      async list(input) {
        const sources = await listDocumentSources(documentSources, input);
        return sources.slice(0, input.limit);
      },
      async get(id) {
        return await documentSources.findSourceById(id);
      },
      async updatePolicy(input) {
        let source = await documentSources.findSourceById(input.id);
        if (source === undefined) {
          return undefined;
        }
        if (input.canUseForAnswering !== undefined) {
          source = await documentSources.setAnsweringEnabled(input.id, input.canUseForAnswering);
        }
        if (input.canUseForKnowledgeDrafts !== undefined) {
          source = await documentSources.setKnowledgeDraftsEnabled(
            input.id,
            input.canUseForKnowledgeDrafts,
          );
        }

        return source;
      },
      async listSnapshots(input) {
        const source = await documentSources.findSourceById(input.id);
        if (source === undefined) {
          return undefined;
        }

        const sourceSnapshots = await snapshots.listSnapshotsForSource(input.id);
        return sourceSnapshots.slice(0, input.limit);
      },
    },
    async registerAuthorizedWikiDocument(input) {
      const source = await documentSources.registerAuthorizedWikiDocument(input);
      const enqueue = await manualPlanner.enqueueSource({ documentSourceId: source.id });

      return { source, enqueue };
    },
    async registerUserSubmittedDocument(input) {
      const source = await documentSources.registerUserSubmittedDocument(input);
      const enqueue = await manualPlanner.enqueueSource({ documentSourceId: source.id });

      return { source, enqueue };
    },
    deadLetters: {
      list(input) {
        return queue.listDeadLetters(input);
      },
      replay(id) {
        return queue.replayDeadLetter(id);
      },
      delete(id) {
        return queue.deleteDeadLetter(id);
      },
      replayBatch(input) {
        return queue.replayDeadLetters(input);
      },
    },
    async close() {
      await loop.stop();
      await redisConnection.then((client) => client.quit());
      await pool.end();
    },
  };
}

function listDocumentSources(
  documentSources: DocumentSyncRuntimeDocumentSources,
  input: DocumentSourceInventoryListInput,
): Promise<DocumentSource[]> {
  if (input.sourceType !== undefined) {
    return documentSources.listSourcesByType(input.sourceType);
  }
  if (input.groupId !== undefined) {
    return documentSources.listSourcesByGroupId(input.groupId);
  }
  if (input.authorizedSpaceId !== undefined) {
    return documentSources.listSourcesByAuthorizedSpaceId(input.authorizedSpaceId);
  }
  if (input.submittedByUserId !== undefined) {
    return documentSources.listSourcesBySubmittingUserId(input.submittedByUserId);
  }
  if (input.usableForAnswering === true) {
    return documentSources.listSourcesUsableForAnswering();
  }

  return documentSources.listSources();
}

function createDefaultDocumentSourceRegistry(pool: PostgresPool): DocumentSyncRuntimeDocumentSources {
  return createPostgresDocumentSourceRegistry(pool as unknown as pg.Pool);
}

function createSyncedSnapshotReindexer({
  embeddingConfig,
  createReindexQueue,
  createReindexPlanner,
  snapshots,
  redisConnection,
}: {
  embeddingConfig: EmbeddingProviderConfig | undefined;
  createReindexQueue: (client: RedisDocumentReindexQueueClient) => DocumentSyncRuntimeReindexQueue;
  createReindexPlanner: (
    dependencies: Parameters<typeof createDocumentReindexPlanner>[0],
  ) => DocumentSyncRuntimeReindexPlanner;
  snapshots: DocumentSyncRuntimeSnapshots;
  redisConnection: Promise<RedisClient>;
}) {
  if (embeddingConfig === undefined) {
    return undefined;
  }
  if (embeddingConfig.dimensions === undefined) {
    throw new Error(
      "IRIS_EMBEDDING_DIMENSIONS is required when document sync reindex enqueue is enabled",
    );
  }
  assertSupportedRuntimeEmbeddingDimension(embeddingConfig.dimensions);

  const embeddingProfileId = createEmbeddingProfileId({
    provider: "openai-compatible",
    model: embeddingConfig.model,
    dimensions: embeddingConfig.dimensions,
  });
  const reindexQueue = createReindexQueue(
    createLazyRedisDocumentReindexQueueClient(redisConnection),
  );
  const reindexPlanner = createReindexPlanner({ snapshots, queue: reindexQueue });

  return {
    enqueueSyncedSnapshotReindex(input: { documentSnapshotId: string }) {
      return reindexPlanner.enqueueSyncedSnapshotReindex({
        embeddingProfileId,
        documentSnapshotId: input.documentSnapshotId,
      });
    },
  };
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

function createLazyRedisDocumentReindexQueueClient(
  redisConnection: Promise<RedisClient>,
): RedisDocumentReindexQueueClient {
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
