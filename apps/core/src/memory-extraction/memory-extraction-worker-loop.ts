import { normalizeWorkerErrorMessage } from "../workers/worker-error-message.js";
import type { MemoryExtractionWorkerResult } from "./memory-extraction-worker.js";

const MAX_TIMER_DELAY_MS = 2_147_483_647;
const MAX_BATCH_LIMIT = 100;

export type MemoryExtractionWorkerLoopDependencies = {
  worker: {
    processBatch(input: { limit: number }): Promise<MemoryExtractionWorkerResult[]>;
  };
  intervalMs: number;
  batchLimit: number;
  onError?: (error: unknown) => void;
  now?: () => Date;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
};

export type MemoryExtractionWorkerBatchSnapshot =
  | {
      status: "succeeded";
      startedAt: Date;
      finishedAt: Date;
      completedCount: number;
      skippedCount: number;
      deferredCount: number;
      failedCount: number;
      failed: false;
    }
  | {
      status: "failed";
      startedAt: Date;
      finishedAt: Date;
      completedCount: 0;
      skippedCount: 0;
      deferredCount: 0;
      failedCount: 0;
      failed: true;
      errorMessage: string;
    };

export type MemoryExtractionWorkerLoopSnapshot = {
  running: boolean;
  intervalMs: number;
  batchLimit: number;
  latestBatch?: MemoryExtractionWorkerBatchSnapshot;
};

export type MemoryExtractionWorkerLoop = {
  start(): void;
  stop(): Promise<void>;
  isRunning(): boolean;
  getSnapshot(): MemoryExtractionWorkerLoopSnapshot;
};

export function createMemoryExtractionWorkerLoop({
  worker,
  intervalMs,
  batchLimit,
  onError,
  now = () => new Date(),
  sleep = abortableSleep,
}: MemoryExtractionWorkerLoopDependencies): MemoryExtractionWorkerLoop {
  const safeIntervalMs = sanitizeInterval(intervalMs);
  const safeBatchLimit = sanitizeBatchLimit(batchLimit);
  let running = false;
  let stopping = false;
  let controller: AbortController | undefined;
  let loopPromise: Promise<void> | undefined;
  let stopPromise: Promise<void> | undefined;
  let latestBatch: MemoryExtractionWorkerBatchSnapshot | undefined;

  const tick = async (): Promise<void> => {
    const startedAt = requireDate(now());
    try {
      const results = await worker.processBatch({ limit: safeBatchLimit });
      latestBatch = {
        status: "succeeded",
        startedAt,
        finishedAt: requireDate(now()),
        completedCount: results.filter((result) => result.status === "completed").length,
        skippedCount: results.filter((result) => result.status === "skipped").length,
        deferredCount: results.filter((result) => result.status === "deferred").length,
        failedCount: results.filter((result) => result.status === "failed").length,
        failed: false,
      };
    } catch (error) {
      latestBatch = {
        status: "failed",
        startedAt,
        finishedAt: requireDate(now()),
        completedCount: 0,
        skippedCount: 0,
        deferredCount: 0,
        failedCount: 0,
        failed: true,
        errorMessage: normalizeWorkerErrorMessage(error),
      };
      reportError(onError, error);
    }
  };

  const consume = async (signal: AbortSignal): Promise<void> => {
    while (running) {
      try {
        await sleep(safeIntervalMs, signal);
      } catch (error) {
        if (!running && isAbortError(error)) {
          return;
        }
        throw error;
      }
      if (!running) {
        return;
      }
      await tick();
    }
  };

  return {
    start() {
      if (stopping) {
        throw new Error("memory extraction loop is stopping");
      }
      if (running) {
        return;
      }
      running = true;
      controller = new AbortController();
      const activeLoop = consume(controller.signal).catch((error) => {
        if (loopPromise === activeLoop) {
          running = false;
        }
        reportError(onError, new Error("memory extraction loop failed"));
        if (!isAbortError(error)) {
          latestBatch = latestBatch ?? {
            status: "failed",
            startedAt: requireDate(now()),
            finishedAt: requireDate(now()),
            completedCount: 0,
            skippedCount: 0,
            deferredCount: 0,
            failedCount: 0,
            failed: true,
            errorMessage: "memory extraction loop failed",
          };
        }
      });
      loopPromise = activeLoop;
    },

    async stop() {
      if (stopPromise !== undefined) {
        await stopPromise;
        return;
      }
      if (!running && loopPromise === undefined) {
        return;
      }
      stopping = true;
      running = false;
      const stoppedController = controller;
      const stoppedLoop = loopPromise;
      stoppedController?.abort();
      const completion = (async () => {
        await stoppedLoop;
        if (loopPromise === stoppedLoop) {
          controller = undefined;
          loopPromise = undefined;
        }
        stopping = false;
        stopPromise = undefined;
      })();
      stopPromise = completion;
      await completion;
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

function abortableSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function abortError(): Error {
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function cloneSnapshot(
  snapshot: MemoryExtractionWorkerBatchSnapshot,
): MemoryExtractionWorkerBatchSnapshot {
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
    // Observability hooks cannot interrupt the single consumer.
  }
}

function sanitizeInterval(value: number): number {
  const interval = requirePositiveSafeInteger("intervalMs", value);
  if (interval > MAX_TIMER_DELAY_MS) {
    throw new Error(`intervalMs must not exceed ${MAX_TIMER_DELAY_MS}`);
  }
  return interval;
}

function sanitizeBatchLimit(value: number): number {
  const limit = requirePositiveSafeInteger("batchLimit", value);
  if (limit > MAX_BATCH_LIMIT) {
    throw new Error(`batchLimit must not exceed ${MAX_BATCH_LIMIT}`);
  }
  return limit;
}

function requirePositiveSafeInteger(fieldName: string, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${fieldName} must be a positive safe integer`);
  }
  return value;
}

function requireDate(value: Date): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new Error("memory extraction loop time must be a valid date");
  }
  return new Date(value);
}
