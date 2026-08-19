import type { KnowledgeConflictDispatcherResult } from "./knowledge-conflict-dispatcher.js";

type TimerHandle = ReturnType<typeof setTimeout>;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const MAX_BATCH_LIMIT = 100;

export type KnowledgeConflictDispatcherBatchSnapshot =
  | {
      status: "succeeded";
      startedAt: Date;
      finishedAt: Date;
      sentCount: number;
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
      retryingCount: 0;
      permanentFailureCount: 0;
      outcomeUnknownCount: 0;
      failed: true;
      errorCode: "worker_failed";
    };

export type KnowledgeConflictDispatcherLoopSnapshot = {
  running: boolean;
  intervalMs: number;
  batchLimit: number;
  latestBatch?: KnowledgeConflictDispatcherBatchSnapshot;
};

export type KnowledgeConflictDispatcherLoopDependencies = {
  worker: { processBatch(input: { limit: number }): Promise<KnowledgeConflictDispatcherResult[]> };
  intervalMs: number;
  batchLimit: number;
  onError?: (error: unknown) => void;
  now?: () => Date;
  setTimeout?: typeof globalThis.setTimeout;
  clearTimeout?: typeof globalThis.clearTimeout;
};

export class KnowledgeConflictDispatcherLoopError extends Error {
  readonly code = "worker_failed" as const;

  constructor() {
    super("knowledge conflict dispatcher worker failed");
    this.name = "KnowledgeConflictDispatcherLoopError";
  }
}

export function createKnowledgeConflictDispatcherLoop({
  worker,
  intervalMs,
  batchLimit,
  onError,
  now = () => new Date(),
  setTimeout: scheduleTimeout = globalThis.setTimeout,
  clearTimeout: cancelTimeout = globalThis.clearTimeout,
}: KnowledgeConflictDispatcherLoopDependencies) {
  const safeIntervalMs = sanitizeInterval(intervalMs);
  const safeBatchLimit = sanitizeBatchLimit(batchLimit);
  let lifecycle: "stopped" | "running" | "stopping" = "stopped";
  let generation = 0;
  let timer: TimerHandle | undefined;
  let inFlight: Promise<void> | undefined;
  let latestBatch: KnowledgeConflictDispatcherBatchSnapshot | undefined;

  const tick = async (): Promise<void> => {
    const startedAt = requireDate(now());
    try {
      const results = await worker.processBatch({ limit: safeBatchLimit });
      latestBatch = {
        status: "succeeded",
        startedAt,
        finishedAt: requireDate(now()),
        sentCount: count(results, "sent"),
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
        retryingCount: 0,
        permanentFailureCount: 0,
        outcomeUnknownCount: 0,
        failed: true,
        errorCode: "worker_failed",
      };
      reportError(onError, new KnowledgeConflictDispatcherLoopError());
    }
  };

  const scheduleNext = (scheduledGeneration: number): void => {
    if (lifecycle !== "running" || scheduledGeneration !== generation) return;
    timer = scheduleTimeout(() => {
      timer = undefined;
      inFlight = tick().finally(() => {
        inFlight = undefined;
        scheduleNext(scheduledGeneration);
      });
    }, safeIntervalMs);
  };

  return {
    start() {
      if (lifecycle !== "stopped") return;
      lifecycle = "running";
      generation += 1;
      scheduleNext(generation);
    },
    async stop() {
      if (lifecycle === "stopped") return;
      lifecycle = "stopping";
      generation += 1;
      if (timer !== undefined) {
        cancelTimeout(timer);
        timer = undefined;
      }
      await inFlight;
      lifecycle = "stopped";
    },
    isRunning() {
      return lifecycle === "running";
    },
    getSnapshot(): KnowledgeConflictDispatcherLoopSnapshot {
      return {
        running: lifecycle === "running",
        intervalMs: safeIntervalMs,
        batchLimit: safeBatchLimit,
        ...(latestBatch === undefined ? {} : { latestBatch: cloneSnapshot(latestBatch) }),
      };
    },
  };
}

function count(
  results: KnowledgeConflictDispatcherResult[],
  status: KnowledgeConflictDispatcherResult["status"],
): number {
  return results.filter((result) => result.status === status).length;
}

function cloneSnapshot(
  snapshot: KnowledgeConflictDispatcherBatchSnapshot,
): KnowledgeConflictDispatcherBatchSnapshot {
  return {
    ...snapshot,
    startedAt: new Date(snapshot.startedAt),
    finishedAt: new Date(snapshot.finishedAt),
  };
}

function reportError(observer: ((error: unknown) => void) | undefined, error: unknown): void {
  try {
    observer?.(error);
  } catch {
    // Observability cannot interrupt the single consumer.
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
    throw new Error("knowledge conflict dispatcher loop time must be a valid date");
  }
  return new Date(value);
}
