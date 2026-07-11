import type { RawEventWorkerResult } from "./raw-event-worker.js";
import { normalizeWorkerErrorMessage } from "../workers/worker-error-message.js";

type TimerHandle = ReturnType<typeof setTimeout>;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

export type RawEventWorkerLoopDependencies = {
  worker: {
    processBatch(input: { limit: number }): Promise<RawEventWorkerResult[]>;
  };
  intervalMs: number;
  batchLimit: number;
  onError?: (error: unknown) => void;
  setTimeout?: typeof globalThis.setTimeout;
  clearTimeout?: typeof globalThis.clearTimeout;
};

export type RawEventWorkerLoop = {
  start(): void;
  stop(): Promise<void>;
  isRunning(): boolean;
  getSnapshot(): RawEventWorkerLoopSnapshot;
};

export type RawEventWorkerLoopSnapshot = {
  running: boolean;
  intervalMs: number;
  batchLimit: number;
  latestBatch?: RawEventWorkerBatchSnapshot;
};

export type RawEventWorkerBatchSnapshot =
  | {
      status: "succeeded";
      startedAt: Date;
      finishedAt: Date;
      processedCount: number;
      failedCount: number;
      failed: false;
    }
  | {
      status: "failed";
      startedAt: Date;
      finishedAt: Date;
      processedCount: 0;
      failedCount: 0;
      failed: true;
      errorMessage: string;
    };

export function createRawEventWorkerLoop({
  worker,
  intervalMs,
  batchLimit,
  onError,
  setTimeout: scheduleTimeout = globalThis.setTimeout,
  clearTimeout: cancelTimeout = globalThis.clearTimeout,
}: RawEventWorkerLoopDependencies): RawEventWorkerLoop {
  const safeIntervalMs = sanitizeTimerIntervalMs(intervalMs);
  const safeBatchLimit = sanitizePositiveInteger("batchLimit", batchLimit);
  let running = false;
  let timer: TimerHandle | undefined;
  let inFlight: Promise<void> | undefined;
  let latestBatch: RawEventWorkerBatchSnapshot | undefined;

  const tick = async () => {
    const startedAt = new Date();
    try {
      const results = await worker.processBatch({ limit: safeBatchLimit });
      latestBatch = {
        status: "succeeded",
        startedAt,
        finishedAt: new Date(),
        processedCount: results.filter((result) => result.status === "processed").length,
        failedCount: results.filter((result) => result.status === "failed").length,
        failed: false,
      };
    } catch (error) {
      latestBatch = {
        status: "failed",
        startedAt,
        finishedAt: new Date(),
        processedCount: 0,
        failedCount: 0,
        failed: true,
        errorMessage: normalizeWorkerErrorMessage(error),
      };
      reportError(onError, error);
    }
  };

  const scheduleNext = () => {
    if (!running) {
      return;
    }

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
      if (running) {
        return;
      }

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
        ...(latestBatch === undefined ? {} : { latestBatch: cloneBatchSnapshot(latestBatch) }),
      };
    },
  };
}

function cloneBatchSnapshot(snapshot: RawEventWorkerBatchSnapshot): RawEventWorkerBatchSnapshot {
  return {
    ...snapshot,
    startedAt: new Date(snapshot.startedAt),
    finishedAt: new Date(snapshot.finishedAt),
  };
}

function reportError(onError: ((error: unknown) => void) | undefined, error: unknown): void {
  try {
    onError?.(error);
  } catch {
    // Observability hooks must not break worker polling.
  }
}

function sanitizePositiveInteger(name: string, value: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${name} must be a positive safe integer`);
  }

  return value;
}

function sanitizeTimerIntervalMs(value: number): number {
  const intervalMs = sanitizePositiveInteger("intervalMs", value);
  if (intervalMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`intervalMs must not exceed ${MAX_TIMER_DELAY_MS}`);
  }

  return intervalMs;
}
