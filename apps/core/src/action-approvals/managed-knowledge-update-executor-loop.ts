import type { ManagedKnowledgeUpdateExecutorResult } from "./managed-knowledge-update-executor.js";
import type { ManagedKnowledgeUpdateReconciliationResult } from "./managed-knowledge-update-reconciler.js";

type TimerHandle = ReturnType<typeof setTimeout>;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const MAX_BATCH_LIMIT = 100;

export type ManagedKnowledgeUpdateBatchSnapshot = {
  status: "succeeded" | "partial_failed" | "failed";
  startedAt: Date;
  finishedAt: Date;
  executionCount: number;
  reconciliationCount: number;
  executorFailed: boolean;
  reconcilerFailed: boolean;
  failed: boolean;
  errorCode?: "managed_update_worker_failed";
};

export type ManagedKnowledgeUpdateExecutorLoopSnapshot = {
  running: boolean;
  intervalMs: number;
  batchLimit: number;
  latestBatch?: ManagedKnowledgeUpdateBatchSnapshot;
};

export function createManagedKnowledgeUpdateExecutorLoop({
  executor,
  reconciler,
  intervalMs,
  batchLimit,
  onError,
  now = () => new Date(),
  setTimeout: scheduleTimeout = globalThis.setTimeout,
  clearTimeout: cancelTimeout = globalThis.clearTimeout,
}: {
  executor: { processBatch(input: { limit: number }): Promise<ManagedKnowledgeUpdateExecutorResult[]> };
  reconciler: { processBatch(input: { limit: number }): Promise<ManagedKnowledgeUpdateReconciliationResult[]> };
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
  let latestBatch: ManagedKnowledgeUpdateBatchSnapshot | undefined;

  const tick = async (): Promise<void> => {
    const startedAt = requireDate(now());
    let executionCount = 0;
    let reconciliationCount = 0;
    let executorFailed = false;
    let reconcilerFailed = false;
    try {
      executionCount = (await executor.processBatch({ limit: safeBatchLimit })).length;
    } catch (error) {
      executorFailed = true;
      reportError(onError, error);
    }
    try {
      reconciliationCount = (await reconciler.processBatch({ limit: safeBatchLimit })).length;
    } catch (error) {
      reconcilerFailed = true;
      reportError(onError, error);
    }
    const failed = executorFailed || reconcilerFailed;
    latestBatch = {
      status: executorFailed && reconcilerFailed
        ? "failed"
        : failed
          ? "partial_failed"
          : "succeeded",
      startedAt,
      finishedAt: requireDate(now()),
      executionCount,
      reconciliationCount,
      executorFailed,
      reconcilerFailed,
      failed,
      ...(failed ? { errorCode: "managed_update_worker_failed" as const } : {}),
    };
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
    getSnapshot(): ManagedKnowledgeUpdateExecutorLoopSnapshot {
      return {
        running,
        intervalMs: safeIntervalMs,
        batchLimit: safeBatchLimit,
        ...(latestBatch === undefined ? {} : { latestBatch: cloneSnapshot(latestBatch) }),
      };
    },
  };
}

function reportError(onError: ((error: unknown) => void) | undefined, error: unknown): void {
  try {
    onError?.(error);
  } catch {
    // Observability cannot interrupt recovery of the other worker.
  }
}

function cloneSnapshot(snapshot: ManagedKnowledgeUpdateBatchSnapshot): ManagedKnowledgeUpdateBatchSnapshot {
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
    throw new Error("managed knowledge update loop time must be valid");
  }
  return new Date(value);
}
