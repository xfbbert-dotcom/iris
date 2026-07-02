import { createClient } from "redis";

import {
  readEventWorkerRuntimeConfig,
  type EnvLike,
  type EventWorkerRuntimeConfig,
} from "../config/env.js";
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
  createRedisClient?: (url: string) => RedisClient;
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

  return createEnabledEventWorkerRuntime({ runtimeConfig, dependencies });
}

function createEnabledEventWorkerRuntime({
  runtimeConfig,
  dependencies,
}: {
  runtimeConfig: Extract<EventWorkerRuntimeConfig, { enabled: true }>;
  dependencies: EventWorkerRuntimeDependencies;
}): EventWorkerRuntime {
  const createRedis =
    dependencies.createRedisClient ??
    ((url: string) => createClient({ url }) as unknown as RedisClient);
  const createLoop = dependencies.createWorkerLoop ?? createRawEventWorkerLoop;

  const redis = createRedis(runtimeConfig.redisUrl);
  const redisConnection = redis.connect().then(() => redis);
  const queue = createRedisRawEventQueue({
    client: createLazyRedisQueueClient(redisConnection),
  });
  const worker = createRawEventWorker({
    queue,
    processor: {
      async process() {
        return undefined;
      },
    },
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
