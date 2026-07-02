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

  const tick = async () => {
    try {
      await worker.processBatch({ limit: safeBatchLimit });
    } catch (error) {
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
  };
}

function sanitizePositiveInteger(name: string, value: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }

  return value;
}
