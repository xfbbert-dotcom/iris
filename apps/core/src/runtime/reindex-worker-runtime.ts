import { createClient } from "redis";

import {
  readEmbeddingProviderConfig,
  readReindexWorkerRuntimeConfig,
  type EmbeddingProviderConfig,
  type EnvLike,
} from "../config/env.js";
import { readDatabaseConfig, type DatabaseConfig } from "../database/database-config.js";
import { createPostgresPool } from "../database/postgres.js";
import { createDocumentChunker } from "../documents/document-chunker.js";
import {
  createDocumentFragmentRepository,
  type DocumentFragmentRepository,
  type Queryable,
} from "../documents/document-fragment-repository.js";
import {
  createDocumentSemanticIndexer,
  type EmbeddingProvider,
} from "../documents/document-semantic-indexer.js";
import type { DocumentSnapshot } from "../documents/document-snapshot-repository.js";
import {
  createDocumentSnapshotRepository,
  type DocumentSnapshotRepository,
} from "../documents/document-snapshot-repository.js";
import {
  createEmbeddingProfileRepository,
  type EmbeddingProfileRepository,
} from "../documents/embedding-profile-repository.js";
import {
  assertSupportedRuntimeEmbeddingDimension,
  createEmbeddingProfileId,
} from "../model/embedding-profile-id.js";
import { createDocumentEmbeddingProvider } from "../model/embedding-input-format.js";
import { createOpenAICompatibleEmbeddingProvider } from "../model/openai-compatible-embedding-provider.js";
import { createDocumentReindexPlanner } from "../reindex/document-reindex-planner.js";
import type {
  DocumentReindexDeadLetter,
  ReplayDocumentReindexDeadLettersResult,
} from "../reindex/document-reindex-queue.js";
import { createDocumentReindexWorker } from "../reindex/document-reindex-worker.js";
import {
  createDocumentReindexWorkerLoop,
  type DocumentReindexWorkerLoop,
  type ReindexWorkerBatchSnapshot,
} from "../reindex/document-reindex-worker-loop.js";
import {
  createRedisDocumentReindexQueue,
  type RedisDocumentReindexQueueClient,
} from "../reindex/redis-document-reindex-queue.js";
import { closeRuntimeResources } from "./runtime-close.js";
import { observeStartupPromise } from "./startup-promise.js";

export type ReindexWorkerRuntime = {
  activeEmbeddingProfileId: string;
  planner: {
    planDocumentProfileReindex(input: {
      embeddingProfileId: string;
      limit: number;
    }): Promise<{ enqueuedCount: number; skippedCount: number }>;
  };
  deadLetters: {
    list(input: { limit: number }): Promise<DocumentReindexDeadLetter[]>;
    replay(id: string): Promise<"replayed" | "not_found" | "unsupported_legacy_item">;
    delete(id: string): Promise<"deleted" | "not_found" | "unsupported_legacy_item">;
    replayBatch(input: { ids: string[] }): Promise<ReplayDocumentReindexDeadLettersResult>;
  };
  getStatus(): Promise<ReindexWorkerRuntimeStatus>;
  start(): void;
  close(): Promise<void>;
};

export type ReindexWorkerRuntimeStatus = {
  enabled: true;
  running: boolean;
  activeEmbeddingProfileId: string;
  intervalMs: number;
  batchLimit: number;
  pendingJobCount: number;
  deadLetterJobCount: number;
  latestBatch?: ReindexWorkerBatchSnapshot;
};

type RedisClient = RedisDocumentReindexQueueClient & {
  connect(): Promise<unknown>;
  quit(): Promise<unknown>;
};

export type ReindexWorkerRuntimeDependencies = {
  createPostgresPool?: (config: DatabaseConfig) => Queryable & { end(): Promise<void> };
  createRedisClient?: (url: string) => RedisClient;
  createEmbeddingProfileRepository?: (dependencies: { queryable: Queryable }) => Pick<
    EmbeddingProfileRepository,
    "findOrCreateProfile" | "getProfileById" | "getStaticDevelopmentProfile"
  >;
  createDocumentSnapshotRepository?: (dependencies: {
    queryable: Queryable;
  }) => Pick<
    DocumentSnapshotRepository,
    "listSuccessfulSnapshotsMissingProfile" | "findSnapshotById"
  >;
  createDocumentFragmentRepository?: (dependencies: {
    queryable: Queryable;
    embeddingProfiles: Pick<EmbeddingProfileRepository, "getProfileById">;
  }) => Pick<
    DocumentFragmentRepository,
    "replaceFragmentsForSnapshot" | "hasFragmentsForSnapshotProfile"
  >;
  createEmbeddingProvider?: (config: EmbeddingProviderConfig) => EmbeddingProvider;
  createWorkerLoop?: typeof createDocumentReindexWorkerLoop;
};

export function createReindexWorkerRuntime({
  env = process.env,
  dependencies = {},
}: {
  env?: EnvLike;
  dependencies?: ReindexWorkerRuntimeDependencies;
} = {}): ReindexWorkerRuntime | undefined {
  const runtimeConfig = readReindexWorkerRuntimeConfig(env);
  if (!runtimeConfig.enabled) {
    return undefined;
  }

  const embeddingConfig = readEmbeddingProviderConfig(env);
  if (embeddingConfig === undefined) {
    throw new Error("IRIS_EMBEDDING_PROVIDER is required when reindex worker is enabled");
  }
  if (embeddingConfig.dimensions === undefined) {
    throw new Error("IRIS_EMBEDDING_DIMENSIONS is required when reindex worker is enabled");
  }
  assertSupportedRuntimeEmbeddingDimension(embeddingConfig.dimensions);

  const createPool = dependencies.createPostgresPool ?? createPostgresPool;
  const createRedis =
    dependencies.createRedisClient ??
    ((url: string) => createClient({ url }) as unknown as RedisClient);
  const createProfiles =
    dependencies.createEmbeddingProfileRepository ?? createEmbeddingProfileRepository;
  const createSnapshots =
    dependencies.createDocumentSnapshotRepository ?? createDocumentSnapshotRepository;
  const createFragments =
    dependencies.createDocumentFragmentRepository ?? createDocumentFragmentRepository;
  const createEmbedding =
    dependencies.createEmbeddingProvider ??
    ((config: EmbeddingProviderConfig) => createOpenAICompatibleEmbeddingProvider({ config }));
  const createLoop = dependencies.createWorkerLoop ?? createDocumentReindexWorkerLoop;

  const pool = createPool(readDatabaseConfig(env));
  const redis = createRedis(runtimeConfig.redisUrl);
  const redisConnection = observeStartupPromise(redis.connect().then(() => redis));
  const queue = createRedisDocumentReindexQueue({
    client: createLazyRedisQueueClient(redisConnection),
  });
  const profiles = createProfiles({ queryable: pool });
  const activeEmbeddingProfileId = createEmbeddingProfileId({
    provider: "openai-compatible",
    model: embeddingConfig.model,
    dimensions: embeddingConfig.dimensions,
  });
  const activeProfilePromise = observeStartupPromise(
    profiles.findOrCreateProfile({
      provider: "openai-compatible",
      model: embeddingConfig.model,
      dimensions: embeddingConfig.dimensions,
      displayName: `OpenAI-compatible ${embeddingConfig.model} (${embeddingConfig.dimensions}d)`,
    }),
  );
  const snapshots = createSnapshots({ queryable: pool });
  const fragments = createFragments({ queryable: pool, embeddingProfiles: profiles });
  const embedder = createDocumentEmbeddingProvider({
    model: embeddingConfig.model,
    delegate: createEmbedding(embeddingConfig),
  });
  const indexer = {
    async indexSnapshot(snapshot: DocumentSnapshot) {
      const activeProfile = await activeProfilePromise;
      return createDocumentSemanticIndexer({
        chunker: createDocumentChunker(),
        embedder,
        embeddingProfileId: activeProfile.id,
        fragments,
        ...(embeddingConfig.batchSize === undefined
          ? {}
          : { embeddingBatchSize: embeddingConfig.batchSize }),
      }).indexSnapshot(snapshot);
    },
  };
  const worker = createDocumentReindexWorker({
    queue,
    activeEmbeddingProfileId,
    snapshots,
    fragments,
    indexer,
  });
  const loop: DocumentReindexWorkerLoop = createLoop({
    worker,
    intervalMs: runtimeConfig.intervalMs,
    batchLimit: runtimeConfig.batchLimit,
    onError: () => undefined,
  });
  const planner = createDocumentReindexPlanner({ snapshots, queue });

  return {
    activeEmbeddingProfileId,
    planner: {
      async planDocumentProfileReindex(input) {
        if (input.embeddingProfileId !== activeEmbeddingProfileId) {
          throw new Error("embeddingProfileId does not match active reindex profile");
        }

        await activeProfilePromise;
        return planner.planDocumentProfileReindex(input);
      },
    },
    deadLetters: {
      list: (input) => queue.listDeadLetters(input),
      replay: (id) => queue.replayDeadLetter(id),
      delete: (id) => queue.deleteDeadLetter(id),
      replayBatch: (input) => queue.replayDeadLetters(input),
    },
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
        activeEmbeddingProfileId,
        intervalMs: loopSnapshot.intervalMs,
        batchLimit: loopSnapshot.batchLimit,
        pendingJobCount,
        deadLetterJobCount,
        ...(loopSnapshot.latestBatch === undefined
          ? {}
          : { latestBatch: loopSnapshot.latestBatch }),
      };
    },
    async close() {
      await closeRuntimeResources([
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

function createLazyRedisQueueClient(
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
