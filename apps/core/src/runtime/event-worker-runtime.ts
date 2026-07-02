import { createClient } from "redis";

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
import { createFeishuDocumentLinkExtractor } from "../documents/feishu-document-link-extractor.js";
import { createGroupVisibleDocumentRegistrar } from "../documents/group-visible-document-registrar.js";
import { createPostgresDocumentSourceRegistry } from "../documents/postgres-document-source-registry.js";
import { createRedisRawEventQueue, type RedisRawEventQueueClient } from "../events/redis-raw-event-queue.js";
import { createRawEventWorker } from "../events/raw-event-worker.js";
import {
  createRawEventWorkerLoop,
  type RawEventWorkerBatchSnapshot,
  type RawEventWorkerLoop,
} from "../events/raw-event-worker-loop.js";

export type EventWorkerRuntime = {
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

type RedisClient = RedisRawEventQueueClient & {
  connect(): Promise<unknown>;
  quit(): Promise<unknown>;
};

export type EventWorkerRuntimeDependencies = {
  createPostgresPool?: (config: DatabaseConfig) => Queryable & { end(): Promise<void> };
  createRedisClient?: (url: string) => RedisClient;
  createConversationMessageRepository?: typeof createPostgresConversationMessageRepository;
  createDocumentSourceRegistry?: typeof createPostgresDocumentSourceRegistry;
  createDocumentLinkExtractor?: typeof createFeishuDocumentLinkExtractor;
  createGroupVisibleDocumentRegistrar?: typeof createGroupVisibleDocumentRegistrar;
  createProcessor?: typeof createFeishuMessageEventProcessor;
  createWorkerLoop?: typeof createRawEventWorkerLoop;
};

export function createEventWorkerRuntime({
  env = process.env,
  dependencies = {},
}: {
  env?: EnvLike;
  dependencies?: EventWorkerRuntimeDependencies;
} = {}): EventWorkerRuntime | undefined {
  const runtimeConfig = readEventWorkerRuntimeConfig(env);
  if (!runtimeConfig.enabled) {
    return undefined;
  }

  return createEnabledEventWorkerRuntime({ env, runtimeConfig, dependencies });
}

function createEnabledEventWorkerRuntime({
  env,
  runtimeConfig,
  dependencies,
}: {
  env: EnvLike;
  runtimeConfig: Extract<EventWorkerRuntimeConfig, { enabled: true }>;
  dependencies: EventWorkerRuntimeDependencies;
}): EventWorkerRuntime {
  const createRedis =
    dependencies.createRedisClient ??
    ((url: string) => createClient({ url }) as unknown as RedisClient);
  const createPool = dependencies.createPostgresPool ?? createPostgresPool;
  const createMessages =
    dependencies.createConversationMessageRepository ??
    createPostgresConversationMessageRepository;
  const createDocumentSources =
    dependencies.createDocumentSourceRegistry ?? createPostgresDocumentSourceRegistry;
  const createDocumentLinkExtractor =
    dependencies.createDocumentLinkExtractor ?? createFeishuDocumentLinkExtractor;
  const createGroupVisibleRegistrar =
    dependencies.createGroupVisibleDocumentRegistrar ?? createGroupVisibleDocumentRegistrar;
  const createProcessor = dependencies.createProcessor ?? createFeishuMessageEventProcessor;
  const createLoop = dependencies.createWorkerLoop ?? createRawEventWorkerLoop;

  const pool = createPool(readDatabaseConfig(env));
  const messages = createMessages({ queryable: pool });
  const documentSources = createDocumentSources(pool);
  const documentLinkExtractor = createDocumentLinkExtractor();
  const groupVisibleDocumentRegistrar = createGroupVisibleRegistrar({
    registry: documentSources,
  });
  const processor = createProcessor({
    messages,
    documentLinkExtractor,
    groupVisibleDocumentRegistrar,
  });
  const redis = createRedis(runtimeConfig.redisUrl);
  const redisConnection = redis.connect().then(() => redis);
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
