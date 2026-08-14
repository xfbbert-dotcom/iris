import type {
  KnowledgeConflictScanner,
  KnowledgeConflictScannerBatchResult,
} from "./knowledge-conflict-scanner.js";

type TimerHandle = ReturnType<typeof setTimeout>;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const MAX_BATCH_LIMIT = 50;

export type KnowledgeConflictScannerBatchSnapshot =
  | ({
      status: "succeeded";
      startedAt: Date;
      finishedAt: Date;
      failed: false;
    } & KnowledgeConflictScannerBatchResult)
  | {
      status: "failed";
      startedAt: Date;
      finishedAt: Date;
      discovered: 0;
      claimed: 0;
      conflict: 0;
      noConflict: 0;
      insufficientEvidence: 0;
      permissionBlocked: 0;
      retrying: 0;
      deadLettered: 0;
      superseded: 0;
      failed: true;
      errorCode: "scanner_failed";
    };

export type KnowledgeConflictScannerLoopSnapshot = {
  running: boolean;
  intervalMs: number;
  batchLimit: number;
  latestBatch?: KnowledgeConflictScannerBatchSnapshot;
};

export type KnowledgeConflictScannerLoop = {
  start(): Promise<void>;
  stop(): Promise<void>;
  isRunning(): boolean;
  getSnapshot(): KnowledgeConflictScannerLoopSnapshot;
};

export function createKnowledgeConflictScannerLoop({
  scanner,
  intervalMs,
  batchLimit,
  onError,
  now = () => new Date(),
  setTimeout: scheduleTimeout = globalThis.setTimeout,
  clearTimeout: cancelTimeout = globalThis.clearTimeout,
}: {
  scanner: KnowledgeConflictScanner;
  intervalMs: number;
  batchLimit: number;
  onError?: (error: unknown) => void;
  now?: () => Date;
  setTimeout?: typeof globalThis.setTimeout;
  clearTimeout?: typeof globalThis.clearTimeout;
}): KnowledgeConflictScannerLoop {
  const safeIntervalMs = requirePositiveInteger("intervalMs", intervalMs, MAX_TIMER_DELAY_MS);
  const safeBatchLimit = requirePositiveInteger("batchLimit", batchLimit, MAX_BATCH_LIMIT);
  let running = false;
  let closed = false;
  let timer: TimerHandle | undefined;
  let inFlight: Promise<void> | undefined;
  let startPromise: Promise<void> | undefined;
  let stopPromise: Promise<void> | undefined;
  let latestBatch: KnowledgeConflictScannerBatchSnapshot | undefined;
  let lastClockValue = new Date(0);

  const readClock = (): Date => {
    lastClockValue = requireDate(now());
    return new Date(lastClockValue);
  };

  const readFailureClock = (): Date => {
    try {
      return readClock();
    } catch {
      return new Date(lastClockValue);
    }
  };

  const tick = async (startup: boolean): Promise<void> => {
    let startedAt = new Date(lastClockValue);
    try {
      startedAt = readClock();
      const result = requireBatchResult(await scanner.scanBatch({ limit: safeBatchLimit }), safeBatchLimit);
      latestBatch = {
        status: "succeeded",
        startedAt,
        finishedAt: readClock(),
        ...result,
        failed: false,
      };
    } catch {
      latestBatch = failedSnapshot(startedAt, readFailureClock());
      if (startup) throw new Error("knowledge conflict scanner startup failed");
      reportError(onError);
    }
  };

  const schedule = (): void => {
    if (!running || closed || timer !== undefined || inFlight !== undefined) return;
    timer = scheduleTimeout(() => {
      timer = undefined;
      inFlight = tick(false).finally(() => {
        inFlight = undefined;
        schedule();
      });
    }, safeIntervalMs);
  };

  return {
    start() {
      if (closed) return Promise.reject(new Error("knowledge conflict scanner loop is closed"));
      if (running) return startPromise ?? Promise.resolve();
      running = true;
      const startup = (async () => {
        try {
          await tick(true);
          schedule();
        } catch {
          running = false;
          throw new Error("knowledge conflict scanner startup failed");
        }
      })();
      startPromise = startup;
      return startup;
    },

    async stop() {
      if (stopPromise !== undefined) return stopPromise;
      closed = true;
      running = false;
      if (timer !== undefined) {
        cancelTimeout(timer);
        timer = undefined;
      }
      const startup = startPromise;
      const active = inFlight;
      const stopping = (async () => {
        await startup?.catch(() => undefined);
        await active;
      })();
      stopPromise = stopping;
      await stopping;
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

function failedSnapshot(startedAt: Date, finishedAt: Date): KnowledgeConflictScannerBatchSnapshot {
  return {
    status: "failed",
    startedAt,
    finishedAt,
    discovered: 0,
    claimed: 0,
    conflict: 0,
    noConflict: 0,
    insufficientEvidence: 0,
    permissionBlocked: 0,
    retrying: 0,
    deadLettered: 0,
    superseded: 0,
    failed: true,
    errorCode: "scanner_failed",
  };
}

function requireBatchResult(
  result: KnowledgeConflictScannerBatchResult,
  limit: number,
): KnowledgeConflictScannerBatchResult {
  const normalized = { ...result };
  for (const [name, value] of Object.entries(normalized)) {
    if (!Number.isSafeInteger(value) || value < 0 || value > limit) {
      throw new Error(`knowledge conflict scanner ${name} count is invalid`);
    }
  }
  const outcomeCount = normalized.conflict + normalized.noConflict
    + normalized.insufficientEvidence + normalized.permissionBlocked
    + normalized.retrying + normalized.deadLettered + normalized.superseded;
  if (outcomeCount !== normalized.claimed) {
    throw new Error("knowledge conflict scanner outcome counts are inconsistent");
  }
  return normalized;
}

function cloneSnapshot(
  snapshot: KnowledgeConflictScannerBatchSnapshot,
): KnowledgeConflictScannerBatchSnapshot {
  return {
    ...snapshot,
    startedAt: new Date(snapshot.startedAt),
    finishedAt: new Date(snapshot.finishedAt),
  };
}

function reportError(observer: ((error: unknown) => void) | undefined): void {
  try {
    observer?.(new Error("knowledge conflict scanner batch failed"));
  } catch {
    // Observability cannot interrupt polling.
  }
}

function requirePositiveInteger(name: string, value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be a positive safe integer no greater than ${maximum}`);
  }
  return value;
}

function requireDate(value: Date): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new Error("knowledge conflict scanner loop time is invalid");
  }
  return new Date(value);
}
