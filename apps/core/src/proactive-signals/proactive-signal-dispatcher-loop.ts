import type { ProactiveSignalDispatcherResult } from "./proactive-signal-dispatcher.js";

type TimerHandle = ReturnType<typeof setTimeout>;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const MAX_BATCH_LIMIT = 100;

export type ProactiveSignalDispatcherBatchSnapshot =
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

export type ProactiveSignalDispatcherLoopSnapshot = {
  running: boolean;
  intervalMs: number;
  batchLimit: number;
  latestBatch?: ProactiveSignalDispatcherBatchSnapshot;
};

export function createProactiveSignalDispatcherLoop({
  worker,
  intervalMs,
  batchLimit,
  onError,
  now = () => new Date(),
  setTimeout: scheduleTimeout = globalThis.setTimeout,
  clearTimeout: cancelTimeout = globalThis.clearTimeout,
}: {
  worker: { processBatch(input: { limit: number }): Promise<ProactiveSignalDispatcherResult[]> };
  intervalMs: number;
  batchLimit: number;
  onError?: (error: unknown) => void;
  now?: () => Date;
  setTimeout?: typeof globalThis.setTimeout;
  clearTimeout?: typeof globalThis.clearTimeout;
}) {
  const safeIntervalMs = requirePositiveInteger("intervalMs", intervalMs, MAX_TIMER_DELAY_MS);
  const safeBatchLimit = requirePositiveInteger("batchLimit", batchLimit, MAX_BATCH_LIMIT);
  let running = false;
  let timer: TimerHandle | undefined;
  let inFlight: Promise<void> | undefined;
  let latestBatch: ProactiveSignalDispatcherBatchSnapshot | undefined;

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
      try {
        onError?.(error);
      } catch {
        // Observability cannot interrupt the loop.
      }
    }
  };
  const schedule = (): void => {
    if (!running) return;
    timer = scheduleTimeout(() => {
      timer = undefined;
      inFlight = tick().finally(() => {
        inFlight = undefined;
        schedule();
      });
    }, safeIntervalMs);
  };
  return {
    start() {
      if (running) return;
      running = true;
      schedule();
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
    getSnapshot(): ProactiveSignalDispatcherLoopSnapshot {
      return {
        running,
        intervalMs: safeIntervalMs,
        batchLimit: safeBatchLimit,
        ...(latestBatch === undefined ? {} : { latestBatch: cloneSnapshot(latestBatch) }),
      };
    },
  };
}

function count(
  results: ProactiveSignalDispatcherResult[],
  status: ProactiveSignalDispatcherResult["status"],
): number {
  return results.filter((result) => result.status === status).length;
}

function cloneSnapshot(
  snapshot: ProactiveSignalDispatcherBatchSnapshot,
): ProactiveSignalDispatcherBatchSnapshot {
  return {
    ...snapshot,
    startedAt: new Date(snapshot.startedAt),
    finishedAt: new Date(snapshot.finishedAt),
  };
}

function requirePositiveInteger(name: string, value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new Error(`${name} must be a positive safe integer no greater than ${maximum}`);
  }
  return value;
}

function requireDate(value: Date): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new Error("proactive signal dispatcher loop time must be valid");
  }
  return new Date(value);
}
