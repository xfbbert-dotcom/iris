import { createClient } from "redis";
import type pg from "pg";

import {
  readEmbeddingProviderConfig,
  readDocumentSyncWorkerRuntimeConfig,
  readFeishuOpenApiConfig,
  readWikiSpaceSyncRuntimeConfig,
  type DocumentSyncWorkerRuntimeConfig,
  type EmbeddingProviderConfig,
  type EnvLike,
  type FeishuOpenApiConfig,
  type WikiSpaceSyncRuntimeConfig,
} from "../config/env.js";
import { readDatabaseConfig, type DatabaseConfig } from "../database/database-config.js";
import { createPostgresPool } from "../database/postgres.js";
import {
  createFeishuDocumentBodyFetcher,
  normalizeFeishuDocumentSourceUri,
  parseFeishuWikiNodeToken,
} from "../documents/feishu-document-body-fetcher.js";
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
  createPostgresWikiSpaceAuthorizationRepository,
  type WikiSpaceAuthorization,
  type WikiSpaceAuthorizationDataSource,
  type WikiSpaceAuthorizationRepository,
  type WikiSpaceScanState,
} from "../documents/wiki-space-authorization-repository.js";
import {
  createFeishuWikiSpaceClient,
  type FeishuWikiSpaceClient,
} from "../documents/feishu-wiki-space-client.js";
import {
  scanFeishuWikiSpace,
  type WikiSpaceScanResult,
} from "../documents/wiki-space-scanner.js";
import {
  createWikiSpaceSyncWorker,
  type AuthorizedWikiDocumentRegistrar,
  type WikiSpaceSyncWorkerResult,
} from "../documents/wiki-space-sync-worker.js";
import {
  createWikiSpaceSyncWorkerLoop,
  type WikiSpaceSyncWorkerBatchSnapshot,
  type WikiSpaceSyncWorkerLoop,
} from "../documents/wiki-space-sync-worker-loop.js";
import { closeRuntimeResources } from "./runtime-close.js";
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
import { observeStartupPromise } from "./startup-promise.js";

const MAX_DOCUMENT_SYNC_RUNTIME_LIST_LIMIT = 100;

export type DocumentSyncRuntime = {
  getStatus(): Promise<DocumentSyncRuntimeStatus>;
  sources: {
    list(input: DocumentSourceInventoryListInput): Promise<DocumentSource[]>;
    get(id: string): Promise<DocumentSource | undefined>;
    updatePolicy(input: DocumentSourcePolicyUpdateInput): Promise<DocumentSource | undefined>;
    listSnapshots(input: DocumentSourceSnapshotListInput): Promise<DocumentSnapshot[] | undefined>;
    getSnapshot(input: DocumentSourceSnapshotGetInput): Promise<DocumentSnapshot | undefined>;
    getLatestSnapshot(
      input: DocumentSourceLatestSnapshotInput,
    ): Promise<DocumentSnapshot | undefined>;
    getLatestSnapshots(
      input: DocumentSourceLatestSnapshotsInput,
    ): Promise<Map<string, DocumentSnapshot>>;
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
  wikiSpaces: {
    register(input: { rootSourceUri: string; at: Date }): Promise<{
      authorization: WikiSpaceAuthorization;
      created: boolean;
    }>;
    list(input: { limit: number }): Promise<WikiSpaceAuthorization[]>;
    requestScan(input: { id: string; at: Date }): Promise<WikiSpaceAuthorization | undefined>;
    setEnabled(input: {
      id: string;
      enabled: boolean;
      at: Date;
    }): Promise<WikiSpaceAuthorization | undefined>;
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
  usableForAnswering?: boolean;
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

export type DocumentSourceSnapshotGetInput = {
  sourceId: string;
  snapshotId: string;
};

export type DocumentSourceLatestSnapshotInput = {
  sourceId: string;
};

export type DocumentSourceLatestSnapshotsInput = {
  sourceIds: string[];
};

export type DocumentSyncRuntimeStatus = {
  enabled: true;
  running: boolean;
  intervalMs: number;
  batchLimit: number;
  pendingJobCount: number;
  deadLetterJobCount: number;
  latestBatch?: DocumentSyncWorkerBatchSnapshot;
  wikiSpaces?: WikiSpaceSyncRuntimeStatus;
};

export type WikiSpaceSyncRuntimeStatus = {
  running: boolean;
  intervalMs: number;
  statusCounts: Record<WikiSpaceScanState, number>;
  latestBatch?: WikiSpaceSyncWorkerBatchSnapshot;
};

type PostgresPool = Queryable & { end(): Promise<void> };
type DocumentSyncRuntimeSnapshots = DocumentSyncSnapshotWriter & {
  findSnapshotById(id: string): Promise<DocumentSnapshot | undefined>;
  findLatestSnapshotForSource(documentSourceId: string): Promise<DocumentSnapshot | undefined>;
  findLatestSnapshotsForSources(documentSourceIds: string[]): Promise<DocumentSnapshot[]>;
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
    | "listSourcesByAnsweringEnabled"
    | "setAnsweringEnabled"
    | "setKnowledgeDraftsEnabled"
    | "updatePolicy"
  >;
type DocumentSyncRuntimeQueue = Pick<
  DocumentSyncQueue,
  | "dequeueBatch"
  | "enqueue"
  | "getPendingCount"
  | "handleProcessedJob"
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
type DocumentSyncRuntimeWikiSpaceRepository = WikiSpaceAuthorizationRepository;
type DocumentSyncRuntimeWikiSpaceWorker = {
  processNext(): Promise<WikiSpaceSyncWorkerResult>;
};
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
    timeoutMs: number;
  }) => FeishuTenantAccessTokenProvider;
  createFeishuDocumentBodyFetcher?: (dependencies: {
    baseUrl: string;
    tokenProvider: FeishuTenantAccessTokenProvider;
    timeoutMs: number;
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
  createWikiSpaceAuthorizationRepository?: (dependencies: {
    dataSource: WikiSpaceAuthorizationDataSource;
  }) => DocumentSyncRuntimeWikiSpaceRepository;
  createFeishuWikiSpaceClient?: (dependencies: {
    baseUrl: string;
    tokenProvider: FeishuTenantAccessTokenProvider;
  }) => FeishuWikiSpaceClient;
  scanFeishuWikiSpace?: (input: {
    client: FeishuWikiSpaceClient;
    rootNodeToken: string;
    maxDepth: number;
  }) => Promise<WikiSpaceScanResult>;
  createWikiSpaceSyncWorker?: (dependencies: {
    repository: Pick<WikiSpaceAuthorizationRepository, "claimNext" | "complete" | "fail">;
    scanner(input: { rootNodeToken: string }): Promise<WikiSpaceScanResult>;
    registrar: AuthorizedWikiDocumentRegistrar;
    leaseMs: number;
    refreshIntervalMs: number;
    maxAttempts: number;
  }) => DocumentSyncRuntimeWikiSpaceWorker;
  createWikiSpaceWorkerLoop?: (dependencies: {
    worker: DocumentSyncRuntimeWikiSpaceWorker;
    intervalMs: number;
    onError: (classification: string) => void;
  }) => WikiSpaceSyncWorkerLoop;
};

export function createDocumentSyncRuntime({
  env = process.env,
  dependencies = {},
}: {
  env?: EnvLike;
  dependencies?: DocumentSyncRuntimeDependencies;
} = {}): DocumentSyncRuntime | undefined {
  const wikiSpaceRuntimeConfig = readWikiSpaceSyncRuntimeConfig(env);
  const runtimeConfig = readDocumentSyncWorkerRuntimeConfig(env);
  if (!runtimeConfig.enabled) {
    return undefined;
  }

  return createEnabledDocumentSyncRuntime({
    env,
    runtimeConfig,
    wikiSpaceRuntimeConfig,
    dependencies,
  });
}

function createEnabledDocumentSyncRuntime({
  env,
  runtimeConfig,
  wikiSpaceRuntimeConfig,
  dependencies,
}: {
  env: EnvLike;
  runtimeConfig: Extract<DocumentSyncWorkerRuntimeConfig, { enabled: true }>;
  wikiSpaceRuntimeConfig: WikiSpaceSyncRuntimeConfig;
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
  const createWikiSpaceRepository =
    dependencies.createWikiSpaceAuthorizationRepository ?? createPostgresWikiSpaceAuthorizationRepository;
  const createWikiClient = dependencies.createFeishuWikiSpaceClient ?? createFeishuWikiSpaceClient;
  const scanWikiSpace = dependencies.scanFeishuWikiSpace ?? scanFeishuWikiSpace;
  const createWikiWorker = dependencies.createWikiSpaceSyncWorker ?? createWikiSpaceSyncWorker;
  const createWikiLoop = dependencies.createWikiSpaceWorkerLoop ?? createWikiSpaceSyncWorkerLoop;

  const feishuConfig = readFeishuOpenApiConfig(env);
  const embeddingConfig = readDocumentSyncReindexEmbeddingConfig(env);
  const pool = createPool(readDatabaseConfig(env));
  let redis: RedisClient;
  try {
    redis = createRedis(runtimeConfig.redisUrl);
  } catch (error) {
    cleanupFailedDocumentSyncRuntimeConstruction({ pool });
    throw error;
  }
  let resolveRedisConnection: (client: RedisClient) => void = () => undefined;
  let rejectRedisConnection: (error: unknown) => void = () => undefined;
  const redisConnection = observeStartupPromise(new Promise<RedisClient>((resolve, reject) => {
    resolveRedisConnection = resolve;
    rejectRedisConnection = reject;
  }));
  const constructRuntimeComponent = <T>(construct: () => T): T => {
    try {
      return construct();
    } catch (error) {
      cleanupFailedDocumentSyncRuntimeConstruction({ redis, pool });
      throw error;
    }
  };

  const documentSources = constructRuntimeComponent(() => createDocumentSources(pool));
  const snapshots = constructRuntimeComponent(() => createSnapshots({ queryable: pool }));
  const tokenProvider = constructRuntimeComponent(() =>
    createTokenProvider({
      baseUrl: feishuConfig.baseUrl,
      appId: feishuConfig.appId,
      appSecret: feishuConfig.appSecret,
      timeoutMs: feishuConfig.documentFetchTimeoutMs,
    }),
  );
  const fetcher = constructRuntimeComponent(() =>
    createBodyFetcher({
      baseUrl: feishuConfig.baseUrl,
      tokenProvider,
      timeoutMs: feishuConfig.documentFetchTimeoutMs,
      maxContentChars: feishuConfig.documentMaxContentChars,
    }),
  );
  const queue = constructRuntimeComponent(() =>
    createQueue(createLazyRedisDocumentSyncQueueClient(redisConnection)),
  );
  const manualPlanner = constructRuntimeComponent(() =>
    createManualPlanner({
      registry: documentSources,
      queue,
    }),
  );
  const wikiSpaceRepository = constructRuntimeComponent(() =>
    createWikiSpaceRepository({
      dataSource: pool as unknown as WikiSpaceAuthorizationDataSource,
    }),
  );
  const wikiSpaceLoop = constructRuntimeComponent(() =>
    createWikiSpaceRuntimeLoop({
      config: wikiSpaceRuntimeConfig,
      feishuConfig,
      tokenProvider,
      repository: wikiSpaceRepository,
      documentSources,
      manualPlanner,
      createWikiClient,
      scanWikiSpace,
      createWikiWorker,
      createWikiLoop,
    }),
  );
  const syncedSnapshotReindexer = constructRuntimeComponent(() =>
    createSyncedSnapshotReindexer({
      embeddingConfig,
      createReindexQueue,
      createReindexPlanner,
      snapshots,
      redisConnection,
    }),
  );
  const runner: DocumentSyncRunner = constructRuntimeComponent(() =>
    createRunner({
      registry: documentSources,
      snapshots,
      fetcher,
      ...(syncedSnapshotReindexer === undefined ? {} : { syncedSnapshotReindexer }),
    }),
  );
  const worker = constructRuntimeComponent(() => createWorker({ queue, runner }));
  const loop: DocumentSyncWorkerLoop = constructRuntimeComponent(() =>
    createLoop({
      worker,
      intervalMs: runtimeConfig.intervalMs,
      batchLimit: runtimeConfig.batchLimit,
      onError: () => undefined,
    }),
  );
  const redisStartup = constructRuntimeComponent(() => redis.connect());
  void redisStartup.then(
    () => resolveRedisConnection(redis),
    (error) => rejectRedisConnection(error),
  );

  return {
    start() {
      loop.start();
      wikiSpaceLoop?.start();
    },
    async getStatus() {
      const loopSnapshot = loop.getSnapshot();
      const pendingJobCount = await queue.getPendingCount();
      const deadLetterJobCount = await queue.getDeadLetterCount();
      const wikiSpaceStatus = await getWikiSpaceRuntimeStatus({
        repository: wikiSpaceRepository,
        loop: wikiSpaceLoop,
      });

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
        ...(wikiSpaceStatus === undefined ? {} : { wikiSpaces: wikiSpaceStatus }),
      };
    },
    enqueueSource(input) {
      return manualPlanner.enqueueSource(input);
    },
    sources: {
      async list(input) {
        const limit = sanitizeLimit(input.limit);
        if (limit === 0) {
          return [];
        }

        const sources = await listDocumentSources(documentSources, input);
        return sources.slice(0, limit);
      },
      async get(id) {
        return await documentSources.findSourceById(id);
      },
      async updatePolicy(input) {
        let source = await documentSources.findSourceById(input.id);
        if (source === undefined) {
          return undefined;
        }

        return await documentSources.updatePolicy(input.id, {
          ...(input.canUseForAnswering === undefined
            ? {}
            : { canUseForAnswering: input.canUseForAnswering }),
          ...(input.canUseForKnowledgeDrafts === undefined
            ? {}
            : { canUseForKnowledgeDrafts: input.canUseForKnowledgeDrafts }),
        });
      },
      async listSnapshots(input) {
        const limit = sanitizeLimit(input.limit);
        const source = await documentSources.findSourceById(input.id);
        if (source === undefined) {
          return undefined;
        }
        if (limit === 0) {
          return [];
        }

        const sourceSnapshots = await snapshots.listSnapshotsForSource(input.id);
        return sourceSnapshots.slice(0, limit);
      },
      async getSnapshot(input) {
        const source = await documentSources.findSourceById(input.sourceId);
        if (source === undefined) {
          return undefined;
        }

        const snapshot = await snapshots.findSnapshotById(input.snapshotId);
        if (snapshot === undefined || snapshot.documentSourceId !== input.sourceId) {
          return undefined;
        }

        return snapshot;
      },
      async getLatestSnapshot(input) {
        const source = await documentSources.findSourceById(input.sourceId);
        if (source === undefined) {
          return undefined;
        }

        return await snapshots.findLatestSnapshotForSource(input.sourceId);
      },
      async getLatestSnapshots(input) {
        if (input.sourceIds.length === 0) {
          return new Map();
        }

        const latestSnapshots = await snapshots.findLatestSnapshotsForSources(input.sourceIds);
        return new Map(
          latestSnapshots.map((snapshot) => [snapshot.documentSourceId, snapshot]),
        );
      },
    },
    async registerAuthorizedWikiDocument(input) {
      const source = await documentSources.registerAuthorizedWikiDocument({
        ...input,
        sourceUri: normalizeFeishuRegistrationSourceUri(input.sourceUri),
      });
      const enqueue = await manualPlanner.enqueueSource({ documentSourceId: source.id });

      return { source, enqueue };
    },
    async registerUserSubmittedDocument(input) {
      const source = await documentSources.registerUserSubmittedDocument({
        ...input,
        sourceUri: normalizeFeishuRegistrationSourceUri(input.sourceUri),
      });
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
    wikiSpaces: {
      register(input) {
        const root = normalizeWikiRootSource(input.rootSourceUri);
        return wikiSpaceRepository.register({
          rootSourceUri: root.sourceUri,
          rootNodeToken: root.nodeToken,
          at: input.at,
        });
      },
      list(input) {
        return wikiSpaceRepository.list(input);
      },
      requestScan(input) {
        return wikiSpaceRepository.requestScan(input);
      },
      setEnabled(input) {
        return wikiSpaceRepository.setEnabled(input);
      },
    },
    async close() {
      await closeRuntimeResources([
        async () => {
          await wikiSpaceLoop?.stop();
        },
        () => loop.stop(),
        async () => {
          const client = await redisConnection;
          await client.quit();
        },
        () => pool.end(),
      ]);
    },
  };
}

function cleanupFailedDocumentSyncRuntimeConstruction({
  redis,
  pool,
}: {
  redis?: RedisClient;
  pool: PostgresPool;
}): void {
  if (redis !== undefined) {
    ignoreCleanupFailure(() => redis.quit());
  }
  ignoreCleanupFailure(() => pool.end());
}

function ignoreCleanupFailure(cleanup: () => Promise<unknown>): void {
  try {
    void cleanup().catch(() => undefined);
  } catch {
    // Preserve the synchronous runtime construction error.
  }
}

function createWikiSpaceRuntimeLoop({
  config,
  feishuConfig,
  tokenProvider,
  repository,
  documentSources,
  manualPlanner,
  createWikiClient,
  scanWikiSpace,
  createWikiWorker,
  createWikiLoop,
}: {
  config: WikiSpaceSyncRuntimeConfig;
  feishuConfig: Pick<FeishuOpenApiConfig, "baseUrl">;
  tokenProvider: FeishuTenantAccessTokenProvider;
  repository: DocumentSyncRuntimeWikiSpaceRepository;
  documentSources: DocumentSyncRuntimeDocumentSources;
  manualPlanner: ManualDocumentSyncPlanner;
  createWikiClient: (dependencies: {
    baseUrl: string;
    tokenProvider: FeishuTenantAccessTokenProvider;
  }) => FeishuWikiSpaceClient;
  scanWikiSpace: (input: {
    client: FeishuWikiSpaceClient;
    rootNodeToken: string;
    maxDepth: number;
  }) => Promise<WikiSpaceScanResult>;
  createWikiWorker: (dependencies: {
    repository: Pick<WikiSpaceAuthorizationRepository, "claimNext" | "complete" | "fail">;
    scanner(input: { rootNodeToken: string }): Promise<WikiSpaceScanResult>;
    registrar: AuthorizedWikiDocumentRegistrar;
    leaseMs: number;
    refreshIntervalMs: number;
    maxAttempts: number;
  }) => DocumentSyncRuntimeWikiSpaceWorker;
  createWikiLoop: (dependencies: {
    worker: DocumentSyncRuntimeWikiSpaceWorker;
    intervalMs: number;
    onError: (classification: string) => void;
  }) => WikiSpaceSyncWorkerLoop;
}): WikiSpaceSyncWorkerLoop | undefined {
  if (!config.enabled) {
    return undefined;
  }

  const client = createWikiClient({
    baseUrl: feishuConfig.baseUrl,
    tokenProvider,
  });
  const worker = createWikiWorker({
    repository,
    scanner(input) {
      return scanWikiSpace({
        client,
        rootNodeToken: input.rootNodeToken,
        maxDepth: config.maxDepth,
      });
    },
    registrar: createWikiDocumentRegistrar({ documentSources, manualPlanner }),
    leaseMs: config.leaseMs,
    refreshIntervalMs: config.refreshIntervalMs,
    maxAttempts: config.maxAttempts,
  });

  return createWikiLoop({
    worker,
    intervalMs: config.intervalMs,
    onError: () => undefined,
  });
}

function createWikiDocumentRegistrar({
  documentSources,
  manualPlanner,
}: {
  documentSources: DocumentSyncRuntimeDocumentSources;
  manualPlanner: ManualDocumentSyncPlanner;
}): AuthorizedWikiDocumentRegistrar {
  return {
    async register(input) {
      const source = await documentSources.registerAuthorizedWikiDocument({
        sourceUri: normalizeFeishuRegistrationSourceUri(input.sourceUri),
        ...(input.title === undefined ? {} : { title: input.title }),
        authorizedSpaceId: input.authorizedSpaceId,
        observedAt: input.observedAt,
      });
      const enqueue = await manualPlanner.enqueueSource({ documentSourceId: source.id });
      if (enqueue.status === "enqueued") {
        return { sourceId: source.id, enqueueStatus: "enqueued" };
      }
      if (enqueue.status === "skipped" && enqueue.reason === "already_syncing") {
        return { sourceId: source.id, enqueueStatus: "already_pending" };
      }

      throw new Error("wiki document registration did not enqueue a document sync job");
    },
  };
}

async function getWikiSpaceRuntimeStatus({
  repository,
  loop,
}: {
  repository: DocumentSyncRuntimeWikiSpaceRepository;
  loop: WikiSpaceSyncWorkerLoop | undefined;
}): Promise<WikiSpaceSyncRuntimeStatus | undefined> {
  if (loop === undefined) {
    return undefined;
  }

  const snapshot = loop.getSnapshot();
  const statusCounts = await repository.getStatusCounts();
  return {
    running: snapshot.running,
    intervalMs: snapshot.intervalMs,
    statusCounts,
    ...(snapshot.latestBatch === undefined ? {} : { latestBatch: snapshot.latestBatch }),
  };
}

function normalizeWikiRootSource(rootSourceUri: string): {
  sourceUri: string;
  nodeToken: string;
} {
  const nodeToken = parseFeishuWikiNodeToken(rootSourceUri);
  if (nodeToken === undefined) {
    throw new Error("unsupported Feishu wiki source URI");
  }

  return {
    sourceUri: normalizeFeishuRegistrationSourceUri(rootSourceUri),
    nodeToken,
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
  if (input.usableForAnswering !== undefined) {
    return documentSources.listSourcesByAnsweringEnabled(input.usableForAnswering);
  }

  return documentSources.listSources();
}

function sanitizeLimit(value: number): number {
  if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) {
    throw new Error("document sync runtime list limit must be a finite safe-magnitude number");
  }

  return Math.min(MAX_DOCUMENT_SYNC_RUNTIME_LIST_LIMIT, Math.max(0, Math.floor(value)));
}

function normalizeFeishuRegistrationSourceUri(sourceUri: string): string {
  const normalized = normalizeFeishuDocumentSourceUri(sourceUri);
  if (normalized === undefined) {
    throw new Error("unsupported Feishu document source URI");
  }

  return normalized;
}

function readDocumentSyncReindexEmbeddingConfig(
  env: EnvLike,
): EmbeddingProviderConfig | undefined {
  const embeddingConfig = readEmbeddingProviderConfig(env);
  if (embeddingConfig === undefined) {
    return undefined;
  }
  if (embeddingConfig.dimensions === undefined) {
    throw new Error(
      "IRIS_EMBEDDING_DIMENSIONS is required when document sync reindex enqueue is enabled",
    );
  }
  assertSupportedRuntimeEmbeddingDimension(embeddingConfig.dimensions);

  return embeddingConfig;
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
    async sRem(key, member) {
      const client = await redisConnection;
      return client.sRem(key, member);
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
    async sRem(key, member) {
      const client = await redisConnection;
      return client.sRem(key, member);
    },
  };
}
