import type {
  ProactiveSignalScanner,
  ProactiveSignalScanResult,
} from "./proactive-signal-scanner.js";

const MAX_TIMER_DELAY_MS = 2_147_483_647;

export type ProactiveSignalWorkerLoopSnapshot = {
  running: boolean;
  intervalMs: number;
  latestScan?:
    | {
        status: "succeeded";
        startedAt: Date;
        finishedAt: Date;
        result: ProactiveSignalScanResult;
      }
    | {
        status: "failed";
        startedAt: Date;
        finishedAt: Date;
        errorMessage: "proactive signal scan failed";
      };
};

export type ProactiveSignalWorkerLoop = {
  start(): void;
  stop(): Promise<void>;
  isRunning(): boolean;
  getSnapshot(): ProactiveSignalWorkerLoopSnapshot;
};

export function createProactiveSignalWorkerLoop({
  scanner,
  intervalMs,
  onError,
  now = () => new Date(),
  sleep = abortableSleep,
}: {
  scanner: ProactiveSignalScanner;
  intervalMs: number;
  onError?: (error: unknown) => void;
  now?: () => Date;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}): ProactiveSignalWorkerLoop {
  const safeIntervalMs = requireInterval(intervalMs);
  let running = false;
  let stopping = false;
  let controller: AbortController | undefined;
  let loopPromise: Promise<void> | undefined;
  let stopPromise: Promise<void> | undefined;
  let latestScan: ProactiveSignalWorkerLoopSnapshot["latestScan"];

  const tick = async () => {
    const startedAt = requireDate(now());
    try {
      const result = await scanner.scan();
      latestScan = {
        status: "succeeded",
        startedAt,
        finishedAt: requireDate(now()),
        result: cloneResult(result),
      };
    } catch (error) {
      latestScan = {
        status: "failed",
        startedAt,
        finishedAt: requireDate(now()),
        errorMessage: "proactive signal scan failed",
      };
      reportError(onError, error);
    }
  };

  const consume = async (signal: AbortSignal) => {
    while (running) {
      try {
        await sleep(safeIntervalMs, signal);
      } catch (error) {
        if (!running && isAbortError(error)) return;
        throw error;
      }
      if (!running) return;
      await tick();
    }
  };

  return {
    start() {
      if (stopping) throw new Error("proactive signal loop is stopping");
      if (running) return;
      running = true;
      controller = new AbortController();
      const activeLoop = consume(controller.signal).catch((error) => {
        if (loopPromise === activeLoop) running = false;
        reportError(onError, error);
      });
      loopPromise = activeLoop;
    },
    async stop() {
      if (stopPromise !== undefined) return stopPromise;
      if (!running && loopPromise === undefined) return;
      stopping = true;
      running = false;
      const activeController = controller;
      const activeLoop = loopPromise;
      activeController?.abort();
      stopPromise = (async () => {
        await activeLoop;
        if (loopPromise === activeLoop) {
          controller = undefined;
          loopPromise = undefined;
        }
        stopping = false;
        stopPromise = undefined;
      })();
      return stopPromise;
    },
    isRunning() {
      return running;
    },
    getSnapshot() {
      return {
        running,
        intervalMs: safeIntervalMs,
        ...(latestScan === undefined ? {} : { latestScan: cloneLatest(latestScan) }),
      };
    },
  };
}

function abortableSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(abortError());
    }, { once: true });
  });
}

function abortError(): Error {
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function cloneLatest(
  value: NonNullable<ProactiveSignalWorkerLoopSnapshot["latestScan"]>,
): NonNullable<ProactiveSignalWorkerLoopSnapshot["latestScan"]> {
  return value.status === "succeeded"
    ? {
        ...value,
        startedAt: new Date(value.startedAt),
        finishedAt: new Date(value.finishedAt),
        result: cloneResult(value.result),
      }
    : {
        ...value,
        startedAt: new Date(value.startedAt),
        finishedAt: new Date(value.finishedAt),
      };
}

function cloneResult(result: ProactiveSignalScanResult): ProactiveSignalScanResult {
  return { ...result };
}

function requireInterval(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_TIMER_DELAY_MS) {
    throw new Error("intervalMs is invalid");
  }
  return value;
}

function requireDate(value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error("proactive signal loop time is invalid");
  }
  return new Date(value);
}

function reportError(observer: ((error: unknown) => void) | undefined, error: unknown): void {
  try {
    observer?.(error);
  } catch {
    // Observer failures cannot stop the scanner loop.
  }
}
