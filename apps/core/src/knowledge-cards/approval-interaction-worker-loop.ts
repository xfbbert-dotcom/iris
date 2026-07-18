import { normalizeWorkerErrorMessage } from "../workers/worker-error-message.js";

import type { ApprovalInteractionWorkerResult } from "./approval-interaction-worker.js";

type TimerHandle = ReturnType<typeof setTimeout>;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const MAX_BATCH_LIMIT = 100;

export type ApprovalInteractionWorkerLoopDependencies = {
  worker: { processBatch(input: { limit: number }): Promise<ApprovalInteractionWorkerResult[]> };
  intervalMs: number;
  batchLimit: number;
  onError?: (error: unknown) => void;
  now?: () => Date;
  setTimeout?: typeof globalThis.setTimeout;
  clearTimeout?: typeof globalThis.clearTimeout;
};

export type ApprovalInteractionWorkerBatchSnapshot =
  | {
      status: "succeeded";
      startedAt: Date;
      finishedAt: Date;
      appliedCount: number;
      alreadyAppliedCount: number;
      deniedCount: number;
      retryingCount: number;
      deadLetteredCount: number;
      failed: false;
    }
  | {
      status: "failed";
      startedAt: Date;
      finishedAt: Date;
      appliedCount: 0;
      alreadyAppliedCount: 0;
      deniedCount: 0;
      retryingCount: 0;
      deadLetteredCount: 0;
      failed: true;
      errorMessage: string;
    };

export type ApprovalInteractionWorkerLoopSnapshot = {
  running: boolean;
  intervalMs: number;
  batchLimit: number;
  latestBatch?: ApprovalInteractionWorkerBatchSnapshot;
};

export type ApprovalInteractionWorkerLoop = {
  start(): void;
  stop(): Promise<void>;
  isRunning(): boolean;
  getSnapshot(): ApprovalInteractionWorkerLoopSnapshot;
};

export function createApprovalInteractionWorkerLoop({
  worker,
  intervalMs,
  batchLimit,
  onError,
  now = () => new Date(),
  setTimeout: scheduleTimeout = globalThis.setTimeout,
  clearTimeout: cancelTimeout = globalThis.clearTimeout,
}: ApprovalInteractionWorkerLoopDependencies): ApprovalInteractionWorkerLoop {
  const safeIntervalMs = sanitizeInterval(intervalMs);
  const safeBatchLimit = sanitizeBatchLimit(batchLimit);
  let running = false;
  let timer: TimerHandle | undefined;
  let inFlight: Promise<void> | undefined;
  let latestBatch: ApprovalInteractionWorkerBatchSnapshot | undefined;

  const tick = async (): Promise<void> => {
    const startedAt = requireDate(now());
    try {
      const results = await worker.processBatch({ limit: safeBatchLimit });
      latestBatch = {
        status: "succeeded",
        startedAt,
        finishedAt: requireDate(now()),
        appliedCount: count(results, "applied"),
        alreadyAppliedCount: count(results, "already_applied"),
        deniedCount: count(results, "denied"),
        retryingCount: count(results, "retrying"),
        deadLetteredCount: count(results, "dead_lettered"),
        failed: false,
      };
    } catch (error) {
      latestBatch = {
        status: "failed",
        startedAt,
        finishedAt: requireDate(now()),
        appliedCount: 0,
        alreadyAppliedCount: 0,
        deniedCount: 0,
        retryingCount: 0,
        deadLetteredCount: 0,
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

function count(results: ApprovalInteractionWorkerResult[], status: ApprovalInteractionWorkerResult["status"]): number {
  return results.filter((result) => result.status === status).length;
}

function cloneSnapshot(
  snapshot: ApprovalInteractionWorkerBatchSnapshot,
): ApprovalInteractionWorkerBatchSnapshot {
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
  if (interval > MAX_TIMER_DELAY_MS) {
    throw new Error(`intervalMs must not exceed ${MAX_TIMER_DELAY_MS}`);
  }
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
    throw new Error("approval interaction loop time must be a valid date");
  }
  return new Date(value);
}
