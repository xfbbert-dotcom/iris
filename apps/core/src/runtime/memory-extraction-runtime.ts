import { createClient } from "redis";

import type { AuditLog } from "../audit/audit-log.js";
import type { RuntimeController } from "../admin/runtime-controller.js";
import {
  readMemoryExtractionRuntimeConfig,
  type EnvLike,
} from "../config/env.js";
import type { DatabaseConfig } from "../database/database-config.js";
import { createPostgresPool } from "../database/postgres.js";
import type { ConversationMessage } from "../conversation/conversation-message-repository.js";
import {
  HttpAiWorkerMemoryExtractionClient,
  type HttpAiWorkerMemoryExtractionClientConfig,
} from "../memory-extraction/http-ai-worker-memory-extraction-client.js";
import type { AiWorkerMemoryExtractionClient } from "../memory-extraction/ai-worker-memory-extraction-client.js";
import {
  createMemoryExtractionPlanner,
  type MemoryExtractionPlanner,
} from "../memory-extraction/memory-extraction-planner.js";
import type {
  MemoryExtractionDeadLetter,
  MemoryExtractionQueue,
  ReplayMemoryExtractionDeadLettersResult,
} from "../memory-extraction/memory-extraction-queue.js";
import {
  createPostgresMemoryExtractionRepository,
  type PostgresMemoryExtractionDataSource,
} from "../memory-extraction/postgres-memory-extraction-repository.js";
import { createMemoryExtractionWorker } from "../memory-extraction/memory-extraction-worker.js";
import {
  createMemoryExtractionWorkerLoop,
  type MemoryExtractionWorkerBatchSnapshot,
  type MemoryExtractionWorkerLoop,
} from "../memory-extraction/memory-extraction-worker-loop.js";
import {
  createRedisMemoryExtractionQueue,
  type RedisMemoryExtractionQueueClient,
} from "../memory-extraction/redis-memory-extraction-queue.js";
import { closeRuntimeResources } from "./runtime-close.js";
import { observeStartupPromise } from "./startup-promise.js";

type PostgresPool = PostgresMemoryExtractionDataSource & { end(): Promise<void> };
type RedisClient = RedisMemoryExtractionQueueClient & {
  connect(): Promise<unknown>;
  quit(): Promise<unknown>;
  destroy(): void;
};

export type MemoryExtractionDeadLetterOperations = {
  list(input: { limit: number }): Promise<MemoryExtractionDeadLetter[]>;
  replay(id: string): Promise<"replayed" | "not_found" | "unsupported_legacy_item">;
  replayBatch(input: { ids: string[] }): Promise<ReplayMemoryExtractionDeadLettersResult>;
  delete(id: string): Promise<"deleted" | "not_found" | "unsupported_legacy_item">;
};

export type MemoryExtractionRuntimeStatus = {
  enabled: true;
  running: boolean;
  workerHealthy: boolean;
  intervalMs: number;
  batchLimit: number;
  minConfidence: number;
  pendingJobCount: number;
  processingJobCount: number;
  delayedJobCount: number;
  deadLetterJobCount: number;
  acceptedCandidateCount: number;
  rejectedCandidateCount: number;
  duplicateCandidateCount: number;
  conflictCandidateCount: number;
  skippedRequestCount: number;
  failedRunCount: number;
  providerCooldownUntil?: Date;
  latestBatch?: MemoryExtractionWorkerBatchSnapshot;
};

export type MemoryExtractionRuntime = {
  planner: MemoryExtractionPlanner;
  deadLetters: MemoryExtractionDeadLetterOperations;
  start(): void;
  getStatus(): Promise<MemoryExtractionRuntimeStatus>;
  close(): Promise<void>;
};

export type MemoryExtractionRuntimeDependencies = {
  createPostgresPool?: (config: DatabaseConfig) => PostgresPool;
  createRedisClient?: (url: string) => RedisClient;
  createRepository?: typeof createPostgresMemoryExtractionRepository;
  createQueue?: typeof createRedisMemoryExtractionQueue;
  createAiWorkerClient?: (
    config: HttpAiWorkerMemoryExtractionClientConfig,
  ) => AiWorkerMemoryExtractionClient;
  createWorker?: typeof createMemoryExtractionWorker;
  createWorkerLoop?: typeof createMemoryExtractionWorkerLoop;
  createPlanner?: typeof createMemoryExtractionPlanner;
};

export function createMemoryExtractionRuntime({
  env = process.env,
  runtimeController,
  auditLog,
  dependencies = {},
}: {
  env?: EnvLike;
  runtimeController?: RuntimeController;
  auditLog?: AuditLog;
  dependencies?: MemoryExtractionRuntimeDependencies;
} = {}): MemoryExtractionRuntime | undefined {
  const runtimeConfig = readMemoryExtractionRuntimeConfig(env);
  if (!runtimeConfig.enabled) {
    return undefined;
  }
  if (runtimeController === undefined) {
    throw new Error("runtimeController is required when memory extraction is enabled");
  }

  const createPool: (config: DatabaseConfig) => PostgresPool =
    dependencies.createPostgresPool ??
    ((config) => createPostgresPool(config) as unknown as PostgresPool);
  const createRedis =
    dependencies.createRedisClient ??
    ((url: string) => createClient({ url }) as unknown as RedisClient);
  const createRepository =
    dependencies.createRepository ?? createPostgresMemoryExtractionRepository;
  const createQueue = dependencies.createQueue ?? createRedisMemoryExtractionQueue;
  const createAiWorkerClient =
    dependencies.createAiWorkerClient ??
    ((config: HttpAiWorkerMemoryExtractionClientConfig) =>
      new HttpAiWorkerMemoryExtractionClient(config));
  const createWorker = dependencies.createWorker ?? createMemoryExtractionWorker;
  const createLoop = dependencies.createWorkerLoop ?? createMemoryExtractionWorkerLoop;
  const createPlanner = dependencies.createPlanner ?? createMemoryExtractionPlanner;

  const client = createAiWorkerClient({
    baseUrl: runtimeConfig.aiWorkerBaseUrl,
    token: runtimeConfig.aiWorkerToken,
  });
  let ownedPool: PostgresPool | undefined;
  let redisConnection: Promise<RedisClient> | undefined;
  let databaseReady: Promise<void> | undefined;
  let dependenciesReady: Promise<void> | undefined;
  const repository = createRepository({
    dataSource: createLazyPostgresDataSource(() => requirePostgresPool(ownedPool)),
  });
  const queue: MemoryExtractionQueue = createQueue({
    client: createLazyRedisClient(() => requireRedisConnection(redisConnection)),
  });
  const planner = createPlanner({
    repository,
    queue,
    runtimeController,
    irisBotOpenId: runtimeConfig.irisBotOpenId,
  });
  const worker = createWorker({
    queue,
    repository,
    client,
    ...(auditLog === undefined ? {} : { auditLog }),
    runtimeController,
    minConfidence: runtimeConfig.minConfidence,
  });
  const loop: MemoryExtractionWorkerLoop = createLoop({
    worker,
    intervalMs: runtimeConfig.intervalMs,
    batchLimit: runtimeConfig.batchLimit,
    onError: () => undefined,
  });
  const redis = createRedis(runtimeConfig.redisUrl);
  ownedPool = createPool({ databaseUrl: runtimeConfig.databaseUrl });

  let startInitiated = false;
  let closing = false;
  let redisConnectStarted = false;
  let redisConnectSettled = false;
  let redisConnected = false;
  let redisDestroyed = false;
  let closePromise: Promise<void> | undefined;

  const close = () => {
    if (closePromise !== undefined) {
      return closePromise;
    }
    closing = true;
    closePromise = closeRuntimeResources([
      () => loop.stop(),
      async () => {
        let destroyError: unknown;
        if (
          redisConnectStarted &&
          !redisConnectSettled &&
          !redisConnected &&
          !redisDestroyed
        ) {
          try {
            redis.destroy();
            redisDestroyed = true;
          } catch (error) {
            destroyError = error;
          }
        }
        const readinessPromises: Promise<unknown>[] = [];
        if (databaseReady !== undefined) readinessPromises.push(databaseReady);
        if (redisConnection !== undefined) readinessPromises.push(redisConnection);
        if (dependenciesReady !== undefined) readinessPromises.push(dependenciesReady);
        await Promise.allSettled(readinessPromises);
        if (redisConnected && !redisDestroyed) {
          await redis.quit();
        }
        if (destroyError !== undefined) {
          throw destroyError;
        }
      },
      () => requirePostgresPool(ownedPool).end(),
    ]);
    return closePromise;
  };

  const exposedPlanner: MemoryExtractionPlanner = {
    async registerMessage(
      message: ConversationMessage,
      identity?: { senderOpenId?: string },
    ) {
      if (dependenciesReady === undefined) {
        throw new Error("memory extraction runtime is not started");
      }
      await dependenciesReady;
      if (closing) {
        return;
      }
      await planner.registerMessage(message, identity);
    },
  };

  return {
    planner: exposedPlanner,
    deadLetters: {
      list: (input) => queue.listDeadLetters(input),
      replay: (id) => queue.replayDeadLetter(id),
      replayBatch: (input) => queue.replayDeadLetters(input),
      delete: (id) => queue.deleteDeadLetter(id),
    },
    start() {
      if (startInitiated || closing) {
        return;
      }
      startInitiated = true;

      const databaseProbe = ownedPool.query<{ ok: number }>("select 1 as ok");
      databaseReady = observeStartupPromise(
        Promise.resolve(databaseProbe).then(() => undefined),
      );
      redisConnection = observeStartupPromise(
        databaseReady.then(async () => {
          if (closing) {
            throw new Error("memory extraction runtime is closing");
          }
          redisConnectStarted = true;
          try {
            await redis.connect();
            redisConnected = true;
            if (closing || redisDestroyed) {
              throw new Error("memory extraction runtime is closing");
            }
            return redis;
          } finally {
            redisConnectSettled = true;
          }
        }),
      );
      dependenciesReady = observeStartupPromise(
        Promise.all([databaseReady, redisConnection]).then(() => undefined),
      );
      void dependenciesReady.then(
        () => {
          if (!closing) {
            loop.start();
          }
        },
        () => {
          void close().catch(() => undefined);
        },
      );
    },
    async getStatus() {
      const loopSnapshot = loop.getSnapshot();
      const [
        workerHealthy,
        pendingJobCount,
        processingJobCount,
        delayedJobCount,
        deadLetterJobCount,
        providerCooldownUntil,
        repositoryStatus,
      ] = await Promise.all([
        readWorkerHealth(client),
        queue.getPendingCount(),
        queue.getProcessingCount(),
        queue.getDelayedCount(),
        queue.getDeadLetterCount(),
        queue.getProviderCooldown(),
        repository.getStatusCounts(),
      ]);

      return {
        enabled: true,
        running: loopSnapshot.running,
        workerHealthy,
        intervalMs: loopSnapshot.intervalMs,
        batchLimit: loopSnapshot.batchLimit,
        minConfidence: runtimeConfig.minConfidence,
        pendingJobCount,
        processingJobCount,
        delayedJobCount,
        deadLetterJobCount,
        acceptedCandidateCount: repositoryStatus.acceptedCandidates,
        rejectedCandidateCount: repositoryStatus.rejectedCandidates,
        duplicateCandidateCount: repositoryStatus.duplicateCandidates,
        conflictCandidateCount: repositoryStatus.conflictCandidates,
        skippedRequestCount: repositoryStatus.skipped,
        failedRunCount: repositoryStatus.failedRuns,
        ...(providerCooldownUntil === undefined
          ? {}
          : { providerCooldownUntil: new Date(providerCooldownUntil) }),
        ...(loopSnapshot.latestBatch === undefined
          ? {}
          : { latestBatch: toContentFreeBatchSnapshot(loopSnapshot.latestBatch) }),
      };
    },
    close,
  };
}

function createLazyPostgresDataSource(
  getPool: () => PostgresPool,
): PostgresMemoryExtractionDataSource {
  return {
    query: (sql, params) => getPool().query(sql, params),
    connect: () => getPool().connect(),
  };
}

function requirePostgresPool(pool: PostgresPool | undefined): PostgresPool {
  if (pool === undefined) {
    throw new Error("memory extraction database is not initialized");
  }
  return pool;
}

function createLazyRedisClient(
  getConnection: () => Promise<RedisClient>,
): RedisMemoryExtractionQueueClient {
  return {
    async eval(script, options) {
      return (await getConnection()).eval(script, options);
    },
    async sCard(key) {
      return (await getConnection()).sCard(key);
    },
    async zCard(key) {
      return (await getConnection()).zCard(key);
    },
    async get(key) {
      return (await getConnection()).get(key);
    },
  };
}

function requireRedisConnection(
  connection: Promise<RedisClient> | undefined,
): Promise<RedisClient> {
  if (connection === undefined) {
    return Promise.reject(new Error("memory extraction runtime is not started"));
  }
  return connection;
}

async function readWorkerHealth(client: AiWorkerMemoryExtractionClient): Promise<boolean> {
  try {
    return await client.checkHealth();
  } catch {
    return false;
  }
}

function toContentFreeBatchSnapshot(
  snapshot: MemoryExtractionWorkerBatchSnapshot,
): MemoryExtractionWorkerBatchSnapshot {
  if (snapshot.status === "failed") {
    return {
      status: "failed",
      startedAt: new Date(snapshot.startedAt),
      finishedAt: new Date(snapshot.finishedAt),
      completedCount: 0,
      skippedCount: 0,
      deferredCount: 0,
      failedCount: 0,
      failed: true,
      errorMessage: "memory_extraction_batch_failed",
    };
  }

  return {
    status: "succeeded",
    startedAt: new Date(snapshot.startedAt),
    finishedAt: new Date(snapshot.finishedAt),
    completedCount: snapshot.completedCount,
    skippedCount: snapshot.skippedCount,
    deferredCount: snapshot.deferredCount,
    failedCount: snapshot.failedCount,
    failed: false,
  };
}
