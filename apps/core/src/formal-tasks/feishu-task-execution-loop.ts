import type { FeishuTaskExecutorResult } from "./feishu-task-executor.js";
import type { FeishuTaskReconciliationResult } from "./feishu-task-reconciler.js";
import type { FeishuTaskResultDispatcherResult } from
  "./feishu-task-result-dispatcher.js";

type TimerHandle = ReturnType<typeof setTimeout>;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const MAX_BATCH_LIMIT = 100;

export type FeishuTaskExecutionBatchSnapshot = {
  status: "succeeded" | "partial_failed" | "failed";
  startedAt: Date;
  finishedAt: Date;
  executionCount: number;
  reconciliationCount: number;
  resultDeliveryCount: number;
  executorFailed: boolean;
  reconcilerFailed: boolean;
  resultDispatcherFailed: boolean;
  failed: boolean;
  errorCode?: "formal_task_worker_failed";
};

export type FeishuTaskExecutionLoopSnapshot = {
  running: boolean;
  intervalMs: number;
  batchLimit: number;
  latestBatch?: FeishuTaskExecutionBatchSnapshot;
};

export function createFeishuTaskExecutionLoop({
  executor,
  reconciler,
  resultDispatcher,
  intervalMs,
  batchLimit,
  onError,
  now = () => new Date(),
  setTimeout: scheduleTimeout = globalThis.setTimeout,
  clearTimeout: cancelTimeout = globalThis.clearTimeout,
}: {
  executor: { processBatch(input: { limit: number }): Promise<FeishuTaskExecutorResult[]> };
  reconciler: { processBatch(input: { limit: number }): Promise<FeishuTaskReconciliationResult[]> };
  resultDispatcher: {
    processBatch(input: { limit: number }): Promise<FeishuTaskResultDispatcherResult[]>;
  };
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
  let latestBatch: FeishuTaskExecutionBatchSnapshot | undefined;

  const tick = async (): Promise<void> => {
    const startedAt = requireDate(now());
    let executionCount = 0;
    let reconciliationCount = 0;
    let resultDeliveryCount = 0;
    let executorFailed = false;
    let reconcilerFailed = false;
    let resultDispatcherFailed = false;
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
    try {
      resultDeliveryCount = (
        await resultDispatcher.processBatch({ limit: safeBatchLimit })
      ).length;
    } catch (error) {
      resultDispatcherFailed = true;
      reportError(onError, error);
    }
    const failureCount = Number(executorFailed) + Number(reconcilerFailed) +
      Number(resultDispatcherFailed);
    const failed = failureCount > 0;
    latestBatch = {
      status: failureCount === 0 ? "succeeded" : failureCount === 3 ? "failed" : "partial_failed",
      startedAt,
      finishedAt: requireDate(now()),
      executionCount,
      reconciliationCount,
      resultDeliveryCount,
      executorFailed,
      reconcilerFailed,
      resultDispatcherFailed,
      failed,
      ...(failed ? { errorCode: "formal_task_worker_failed" as const } : {}),
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
    getSnapshot(): FeishuTaskExecutionLoopSnapshot {
      return {
        running,
        intervalMs: safeIntervalMs,
        batchLimit: safeBatchLimit,
        ...(latestBatch === undefined ? {} : { latestBatch: cloneSnapshot(latestBatch) }),
      };
    },
  };
}

function reportError(handler: ((error: unknown) => void) | undefined, error: unknown): void {
  try {
    handler?.(error);
  } catch {
    // Observability cannot interrupt the remaining isolated stages.
  }
}

function cloneSnapshot(snapshot: FeishuTaskExecutionBatchSnapshot): FeishuTaskExecutionBatchSnapshot {
  return {
    ...snapshot,
    startedAt: new Date(snapshot.startedAt),
    finishedAt: new Date(snapshot.finishedAt),
  };
}

function requirePositiveInteger(name: string, value: unknown, maximum: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > maximum) {
    throw new Error(`${name} is invalid`);
  }
  return Number(value);
}

function requireDate(value: unknown): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error("formal task worker time is invalid");
  }
  return new Date(value);
}
