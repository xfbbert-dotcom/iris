import { normalizeWorkerErrorMessage } from "../workers/worker-error-message.js";

import type { KnowledgeCardDispatcherResult } from "./knowledge-card-dispatcher.js";

type TimerHandle = ReturnType<typeof setTimeout>;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const MAX_BATCH_LIMIT = 100;

export type KnowledgeCardDispatcherLoopDependencies = {
  worker: { processBatch(input: { limit: number }): Promise<KnowledgeCardDispatcherResult[]> };
  intervalMs: number;
  batchLimit: number;
  onError?: (error: unknown) => void;
  now?: () => Date;
  setTimeout?: typeof globalThis.setTimeout;
  clearTimeout?: typeof globalThis.clearTimeout;
};

export type KnowledgeCardDispatcherBatchSnapshot =
  | {
      status: "succeeded";
      startedAt: Date;
      finishedAt: Date;
      sentCount: number;
      updatedCount: number;
      retryingCount: number;
      permanentFailureCount: number;
      outcomeUnknownCount: number;
      failed: false;
    }
  | {
      status: "failed";
      startedAt: Date;
      finishedAt: Date;
      sentCount: 0;
      updatedCount: 0;
      retryingCount: 0;
      permanentFailureCount: 0;
      outcomeUnknownCount: 0;
      failed: true;
      errorMessage: string;
    };

export type KnowledgeCardDispatcherLoopSnapshot = {
  running: boolean;
  intervalMs: number;
  batchLimit: number;
  latestBatch?: KnowledgeCardDispatcherBatchSnapshot;
};

export type KnowledgeCardDispatcherLoop = {
  start(): void;
  stop(): Promise<void>;
  isRunning(): boolean;
  getSnapshot(): KnowledgeCardDispatcherLoopSnapshot;
};

export function createKnowledgeCardDispatcherLoop({
  worker,
  intervalMs,
  batchLimit,
  onError,
  now = () => new Date(),
  setTimeout: scheduleTimeout = globalThis.setTimeout,
  clearTimeout: cancelTimeout = globalThis.clearTimeout,
}: KnowledgeCardDispatcherLoopDependencies): KnowledgeCardDispatcherLoop {
  const safeIntervalMs = sanitizeInterval(intervalMs);
  const safeBatchLimit = sanitizeBatchLimit(batchLimit);
  let running = false;
  let timer: TimerHandle | undefined;
  let inFlight: Promise<void> | undefined;
  let latestBatch: KnowledgeCardDispatcherBatchSnapshot | undefined;

  const tick = async (): Promise<void> => {
    const startedAt = requireDate(now());
    try {
      const results = await worker.processBatch({ limit: safeBatchLimit });
      latestBatch = {
        status: "succeeded",
        startedAt,
        finishedAt: requireDate(now()),
        sentCount: count(results, "sent"),
        updatedCount: count(results, "updated"),
        retryingCount: count(results, "retrying"),
        permanentFailureCount: count(results, "permanent_failure"),
        outcomeUnknownCount: count(results, "outcome_unknown"),
        failed: false,
      };
    } catch (error) {
      latestBatch = {
        status: "failed",
        startedAt,
        finishedAt: requireDate(now()),
        sentCount: 0,
        updatedCount: 0,
        retryingCount: 0,
        permanentFailureCount: 0,
        outcomeUnknownCount: 0,
        failed: true,
        errorMessage: normalizeWorkerErrorMessage(error),
      };
      reportError(onError, error);
    }
  };

  const scheduleNext = (): void => {
    if (!running) return;
    timer = scheduleTimeout(() => {
      timer = undefined;
      inFlight = tick().finally(() => {
        inFlight = undefined;
        scheduleNext();
      });
    }, safeIntervalMs);
  };

  return {
    start() {
      if (running) return;
      running = true;
      scheduleNext();
    },
    async stop() {
      running = false;
      if (timer !== undefined) {
        cancelTimeout(timer);
        timer = undefined;
      }
      await inFlight;
    },
    isRunning() {
      return running;
    },
    getSnapshot() {
      return {
        running,
        intervalMs: safeIntervalMs,
        batchLimit: safeBatchLimit,
        ...(latestBatch === undefined ? {} : { latestBatch: cloneSnapshot(latestBatch) }),
      };
    },
  };
}

function count(results: KnowledgeCardDispatcherResult[], status: KnowledgeCardDispatcherResult["status"]): number {
  return results.filter((result) => result.status === status).length;
}

function cloneSnapshot(snapshot: KnowledgeCardDispatcherBatchSnapshot): KnowledgeCardDispatcherBatchSnapshot {
  return { ...snapshot, startedAt: new Date(snapshot.startedAt), finishedAt: new Date(snapshot.finishedAt) };
}

function reportError(observer: ((error: unknown) => void) | undefined, error: unknown): void {
  try {
    observer?.(error);
  } catch {
    // Observability hooks cannot interrupt the single consumer.
  }
}

function sanitizeInterval(value: number): number {
  const interval = requirePositiveSafeInteger("intervalMs", value);
  if (interval > MAX_TIMER_DELAY_MS) throw new Error(`intervalMs must not exceed ${MAX_TIMER_DELAY_MS}`);
  return interval;
}

function sanitizeBatchLimit(value: number): number {
  const limit = requirePositiveSafeInteger("batchLimit", value);
  if (limit > MAX_BATCH_LIMIT) throw new Error(`batchLimit must not exceed ${MAX_BATCH_LIMIT}`);
  return limit;
}

function requirePositiveSafeInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value;
}

function requireDate(value: Date): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new Error("knowledge card dispatcher loop time must be a valid date");
  }
  return new Date(value);
}
