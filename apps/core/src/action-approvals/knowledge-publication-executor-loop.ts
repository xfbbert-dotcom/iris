import type {
  KnowledgePublicationExecutorResult,
} from "./knowledge-publication-executor.js";

type TimerHandle = ReturnType<typeof setTimeout>;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const MAX_BATCH_LIMIT = 100;

export type KnowledgePublicationExecutorBatchSnapshot =
  | {
      status: "succeeded";
      startedAt: Date;
      finishedAt: Date;
      publishedCount: number;
      skippedCount: number;
      failedCount: number;
      failed: false;
    }
  | {
      status: "failed";
      startedAt: Date;
      finishedAt: Date;
      publishedCount: 0;
      skippedCount: 0;
      failedCount: 0;
      failed: true;
      errorCode: "publication_executor_failed";
    };

export type KnowledgePublicationExecutorLoopSnapshot = {
  running: boolean;
  intervalMs: number;
  batchLimit: number;
  latestBatch?: KnowledgePublicationExecutorBatchSnapshot;
};

export function createKnowledgePublicationExecutorLoop({
  executor,
  intervalMs,
  batchLimit,
  onError,
  now = () => new Date(),
  setTimeout: scheduleTimeout = globalThis.setTimeout,
  clearTimeout: cancelTimeout = globalThis.clearTimeout,
}: {
  executor: { processBatch(input: { limit: number }): Promise<KnowledgePublicationExecutorResult[]> };
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
  let latestBatch: KnowledgePublicationExecutorBatchSnapshot | undefined;

  const tick = async (): Promise<void> => {
    const startedAt = requireDate(now());
    try {
      const results = await executor.processBatch({ limit: safeBatchLimit });
      latestBatch = {
        status: "succeeded",
        startedAt,
        finishedAt: requireDate(now()),
        publishedCount: count(results, "published"),
        skippedCount: count(results, "skipped"),
        failedCount: count(results, "failed"),
        failed: false,
      };
    } catch (error) {
      latestBatch = {
        status: "failed",
        startedAt,
        finishedAt: requireDate(now()),
        publishedCount: 0,
        skippedCount: 0,
        failedCount: 0,
        failed: true,
        errorCode: "publication_executor_failed",
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
    getSnapshot(): KnowledgePublicationExecutorLoopSnapshot {
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
  results: KnowledgePublicationExecutorResult[],
  status: KnowledgePublicationExecutorResult["status"],
): number {
  return results.filter((result) => result.status === status).length;
}

function cloneSnapshot(
  snapshot: KnowledgePublicationExecutorBatchSnapshot,
): KnowledgePublicationExecutorBatchSnapshot {
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
    throw new Error("knowledge publication executor loop time must be valid");
  }
  return new Date(value);
}
