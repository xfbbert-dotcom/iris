import { WikiSpaceSyncError } from "./feishu-wiki-space-client.js";
import type { WikiSpaceSyncWorkerResult } from "./wiki-space-sync-worker.js";

type TimerHandle = ReturnType<typeof setTimeout>;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

export type WikiSpaceSyncWorkerLoopDependencies = {
  worker: { processNext(): Promise<WikiSpaceSyncWorkerResult> };
  intervalMs: number;
  onError?: (classification: string) => void;
  setTimeout?: typeof globalThis.setTimeout;
  clearTimeout?: typeof globalThis.clearTimeout;
};

export type WikiSpaceSyncWorkerLoop = {
  start(): void;
  stop(): Promise<void>;
  isRunning(): boolean;
  getSnapshot(): WikiSpaceSyncWorkerLoopSnapshot;
};

export type WikiSpaceSyncWorkerLoopSnapshot = {
  running: boolean;
  intervalMs: number;
  latestBatch?: WikiSpaceSyncWorkerBatchSnapshot;
};

export type WikiSpaceSyncWorkerBatchSnapshot =
  | {
      status: "succeeded";
      startedAt: Date;
      finishedAt: Date;
      result: WikiSpaceSyncWorkerResult;
      failed: false;
    }
  | {
      status: "failed";
      startedAt: Date;
      finishedAt: Date;
      classification: string;
      failed: true;
    };

export function createWikiSpaceSyncWorkerLoop({
  worker,
  intervalMs,
  onError,
  setTimeout: scheduleTimeout = globalThis.setTimeout,
  clearTimeout: cancelTimeout = globalThis.clearTimeout,
}: WikiSpaceSyncWorkerLoopDependencies): WikiSpaceSyncWorkerLoop {
  const safeIntervalMs = requireTimerIntervalMs(intervalMs);
  let running = false;
  let timer: TimerHandle | undefined;
  let inFlight: Promise<void> | undefined;
  let latestBatch: WikiSpaceSyncWorkerBatchSnapshot | undefined;

  const tick = async () => {
    const startedAt = new Date();
    try {
      const result = await worker.processNext();
      latestBatch = {
        status: "succeeded",
        startedAt,
        finishedAt: new Date(),
        result,
        failed: false,
      };
    } catch (error) {
      const classification = classifyLoopError(error);
      latestBatch = {
        status: "failed",
        startedAt,
        finishedAt: new Date(),
        classification,
        failed: true,
      };
      reportError(onError, classification);
    }
  };

  const scheduleNext = () => {
    if (!running || timer !== undefined || inFlight !== undefined) return;
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
        ...(latestBatch === undefined ? {} : { latestBatch: cloneBatchSnapshot(latestBatch) }),
      };
    },
  };
}

function cloneBatchSnapshot(snapshot: WikiSpaceSyncWorkerBatchSnapshot): WikiSpaceSyncWorkerBatchSnapshot {
  if (snapshot.status === "succeeded") {
    return {
      ...snapshot,
      startedAt: new Date(snapshot.startedAt),
      finishedAt: new Date(snapshot.finishedAt),
      result: { ...snapshot.result },
    };
  }
  return {
    ...snapshot,
    startedAt: new Date(snapshot.startedAt),
    finishedAt: new Date(snapshot.finishedAt),
  };
}

function classifyLoopError(error: unknown): string {
  return error instanceof WikiSpaceSyncError ? error.classification : "internal_error";
}

function reportError(onError: ((classification: string) => void) | undefined, classification: string): void {
  try {
    onError?.(classification);
  } catch {
    // Observability hooks must not break worker polling.
  }
}

function requireTimerIntervalMs(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("intervalMs must be a positive safe integer");
  }
  if (value > MAX_TIMER_DELAY_MS) {
    throw new Error(`intervalMs must not exceed ${MAX_TIMER_DELAY_MS}`);
  }
  return value;
}
