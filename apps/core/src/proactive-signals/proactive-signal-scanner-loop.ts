import type { ProactiveSignalScanResult, ProactiveSignalScanner } from "./proactive-signal-scanner.js";

type TimerHandle = ReturnType<typeof setTimeout>;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const MAX_BATCH_LIMIT = 100;

export type ProactiveSignalScannerBatchSnapshot =
  | {
      status: "succeeded";
      startedAt: Date;
      finishedAt: Date;
      scannedCount: number;
      skippedCount: number;
      recordedCount: number;
      existingCount: number;
      suppressedCount: number;
      failed: false;
    }
  | {
      status: "failed";
      startedAt: Date;
      finishedAt: Date;
      scannedCount: 0;
      skippedCount: 0;
      recordedCount: 0;
      existingCount: 0;
      suppressedCount: 0;
      failed: true;
      errorCode: "scanner_failed";
    };

export type ProactiveSignalScannerLoopSnapshot = {
  running: boolean;
  intervalMs: number;
  batchLimit: number;
  latestBatch?: ProactiveSignalScannerBatchSnapshot;
};

export type ProactiveSignalScannerLoop = {
  start(): void;
  stop(): Promise<void>;
  getSnapshot(): ProactiveSignalScannerLoopSnapshot;
};

export function createProactiveSignalScannerLoop({
  scanner,
  groupIds,
  intervalMs,
  batchLimit,
  onError,
  now = () => new Date(),
  setTimeout: scheduleTimeout = globalThis.setTimeout,
  clearTimeout: cancelTimeout = globalThis.clearTimeout,
}: {
  scanner: ProactiveSignalScanner;
  groupIds: string[];
  intervalMs: number;
  batchLimit: number;
  onError?: (error: unknown) => void;
  now?: () => Date;
  setTimeout?: typeof globalThis.setTimeout;
  clearTimeout?: typeof globalThis.clearTimeout;
}): ProactiveSignalScannerLoop {
  const safeGroupIds = normalizeGroupIds(groupIds);
  const safeIntervalMs = requirePositiveInteger("intervalMs", intervalMs, MAX_TIMER_DELAY_MS);
  const safeBatchLimit = requirePositiveInteger("batchLimit", batchLimit, MAX_BATCH_LIMIT);
  let running = false;
  let cursor = 0;
  let timer: TimerHandle | undefined;
  let inFlight: Promise<void> | undefined;
  let latestBatch: ProactiveSignalScannerBatchSnapshot | undefined;

  const tick = async (): Promise<void> => {
    const startedAt = requireDate(now());
    try {
      const results: ProactiveSignalScanResult[] = [];
      for (let index = 0; index < Math.min(safeBatchLimit, safeGroupIds.length); index += 1) {
        const groupId = safeGroupIds[cursor % safeGroupIds.length]!;
        cursor += 1;
        results.push(await scanner.scanOnce({ groupId, limit: safeBatchLimit }));
      }
      latestBatch = {
        status: "succeeded",
        startedAt,
        finishedAt: requireDate(now()),
        scannedCount: results.filter((result) => result.status === "recorded").length,
        skippedCount: results.filter((result) => result.status === "skipped").length,
        recordedCount: results.reduce((count, result) => count + result.recordedCount, 0),
        existingCount: results.reduce((count, result) => count + result.existingCount, 0),
        suppressedCount: results.reduce((count, result) => count + result.suppressedCount, 0),
        failed: false,
      };
    } catch (error) {
      latestBatch = {
        status: "failed",
        startedAt,
        finishedAt: requireDate(now()),
        scannedCount: 0,
        skippedCount: 0,
        recordedCount: 0,
        existingCount: 0,
        suppressedCount: 0,
        failed: true,
        errorCode: "scanner_failed",
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

function normalizeGroupIds(groupIds: string[]): string[] {
  const normalized = [...new Set(groupIds.map((groupId) => groupId.trim()).filter(Boolean))];
  if (normalized.length === 0) throw new Error("proactive signal scanner groupIds are required");
  if (normalized.some((groupId) => groupId.length > 512)) {
    throw new Error("proactive signal scanner groupIds are invalid");
  }
  return normalized;
}

function cloneSnapshot(snapshot: ProactiveSignalScannerBatchSnapshot): ProactiveSignalScannerBatchSnapshot {
  return { ...snapshot, startedAt: new Date(snapshot.startedAt), finishedAt: new Date(snapshot.finishedAt) };
}

function requirePositiveInteger(name: string, value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new Error(`${name} must be a positive safe integer no greater than ${maximum}`);
  }
  return value;
}

function requireDate(value: Date): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new Error("proactive signal scanner loop time must be valid");
  }
  return new Date(value);
}
