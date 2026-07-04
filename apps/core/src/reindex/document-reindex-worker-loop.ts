import type { DocumentReindexJobResult } from "./document-reindex-worker.js";

type TimerHandle = ReturnType<typeof setTimeout>;

export type DocumentReindexWorkerLoopDependencies = {
  worker: {
    processBatch(input: { limit: number }): Promise<DocumentReindexJobResult[]>;
  };
  intervalMs: number;
  batchLimit: number;
  onError?: (error: unknown) => void;
  setTimeout?: typeof globalThis.setTimeout;
  clearTimeout?: typeof globalThis.clearTimeout;
};

export type DocumentReindexWorkerLoop = {
  start(): void;
  stop(): Promise<void>;
  isRunning(): boolean;
  getSnapshot(): DocumentReindexWorkerLoopSnapshot;
};

export type DocumentReindexWorkerLoopSnapshot = {
  running: boolean;
  intervalMs: number;
  batchLimit: number;
  latestBatch?: ReindexWorkerBatchSnapshot;
};

export type ReindexWorkerBatchSnapshot =
  | {
      status: "succeeded";
      startedAt: Date;
      finishedAt: Date;
      indexedCount: number;
      skippedCount: number;
      failedCount: number;
      failed: false;
    }
  | {
      status: "failed";
      startedAt: Date;
      finishedAt: Date;
      indexedCount: 0;
      skippedCount: 0;
      failedCount: 0;
      failed: true;
      errorMessage: string;
    };

export function createDocumentReindexWorkerLoop({
  worker,
  intervalMs,
  batchLimit,
  onError,
  setTimeout: scheduleTimeout = globalThis.setTimeout,
  clearTimeout: cancelTimeout = globalThis.clearTimeout,
}: DocumentReindexWorkerLoopDependencies): DocumentReindexWorkerLoop {
  const safeIntervalMs = sanitizePositiveInteger("intervalMs", intervalMs);
  const safeBatchLimit = sanitizePositiveInteger("batchLimit", batchLimit);
  let running = false;
  let timer: TimerHandle | undefined;
  let inFlight: Promise<void> | undefined;
  let latestBatch: ReindexWorkerBatchSnapshot | undefined;

  const tick = async () => {
    const startedAt = new Date();
    try {
      const results = await worker.processBatch({ limit: safeBatchLimit });
      latestBatch = {
        status: "succeeded",
        startedAt,
        finishedAt: new Date(),
        indexedCount: results.filter((result) => result.status === "indexed").length,
        skippedCount: results.filter((result) => result.status === "skipped").length,
        failedCount: results.filter((result) => result.status === "failed").length,
        failed: false,
      };
    } catch (error) {
      latestBatch = {
        status: "failed",
        startedAt,
        finishedAt: new Date(),
        indexedCount: 0,
        skippedCount: 0,
        failedCount: 0,
        failed: true,
        errorMessage: error instanceof Error ? error.message : String(error),
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

function cloneBatchSnapshot(snapshot: ReindexWorkerBatchSnapshot): ReindexWorkerBatchSnapshot {
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
