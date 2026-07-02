import type { DocumentSyncWorkerResult } from "./document-sync-worker.js";

type TimerHandle = ReturnType<typeof setTimeout>;

export type DocumentSyncWorkerLoopDependencies = {
  worker: {
    processBatch(input: { limit: number }): Promise<DocumentSyncWorkerResult[]>;
  };
  intervalMs: number;
  batchLimit: number;
  onError?: (error: unknown) => void;
  setTimeout?: typeof globalThis.setTimeout;
  clearTimeout?: typeof globalThis.clearTimeout;
};

export type DocumentSyncWorkerLoop = {
  start(): void;
  stop(): Promise<void>;
  isRunning(): boolean;
  getSnapshot(): DocumentSyncWorkerLoopSnapshot;
};

export type DocumentSyncWorkerLoopSnapshot = {
  running: boolean;
  intervalMs: number;
  batchLimit: number;
  latestBatch?: DocumentSyncWorkerBatchSnapshot;
};

export type DocumentSyncWorkerBatchSnapshot =
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

export function createDocumentSyncWorkerLoop({
  worker,
  intervalMs,
  batchLimit,
  onError,
  setTimeout: scheduleTimeout = globalThis.setTimeout,
  clearTimeout: cancelTimeout = globalThis.clearTimeout,
}: DocumentSyncWorkerLoopDependencies): DocumentSyncWorkerLoop {
  const safeIntervalMs = sanitizePositiveInteger("intervalMs", intervalMs);
  const safeBatchLimit = sanitizePositiveInteger("batchLimit", batchLimit);
  let running = false;
  let timer: TimerHandle | undefined;
  let inFlight: Promise<void> | undefined;
  let latestBatch: DocumentSyncWorkerBatchSnapshot | undefined;

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
        errorMessage: error instanceof Error ? error.message : String(error),
      };
      onError?.(error);
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
        ...(latestBatch === undefined ? {} : { latestBatch }),
      };
    },
  };
}

function sanitizePositiveInteger(name: string, value: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }

  return value;
}
