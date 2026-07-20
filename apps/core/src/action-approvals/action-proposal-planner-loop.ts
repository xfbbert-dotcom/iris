import type {
  ActionProposalPlanBatchResult,
  ActionProposalPlanner,
} from "./action-proposal-planner.js";

type TimerHandle = ReturnType<typeof setTimeout>;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const MAX_BATCH_LIMIT = 100;

export type ActionProposalPlannerBatchSnapshot = ActionProposalPlanBatchResult & {
  status: "succeeded";
  startedAt: Date;
  finishedAt: Date;
  skippedByGate: boolean;
  failed: false;
} | {
  status: "failed";
  startedAt: Date;
  finishedAt: Date;
  candidateCount: 0;
  plannedCount: 0;
  alreadyPlannedCount: 0;
  ineligibleCount: 0;
  failedCount: 0;
  cancelledStaleCount: 0;
  skippedByGate: false;
  failed: true;
  errorCode: "planner_failed";
};

export type ActionProposalPlannerLoop = {
  start(): void;
  stop(): Promise<void>;
  isRunning(): boolean;
  getSnapshot(): {
    running: boolean;
    intervalMs: number;
    batchLimit: number;
    latestBatch?: ActionProposalPlannerBatchSnapshot;
  };
};

export function createActionProposalPlannerLoop(input: {
  planner: Pick<ActionProposalPlanner, "planBatch">;
  canRun: () => boolean;
  intervalMs: number;
  batchLimit: number;
  onError?: (error: unknown) => void;
  now?: () => Date;
  setTimeout?: typeof globalThis.setTimeout;
  clearTimeout?: typeof globalThis.clearTimeout;
}): ActionProposalPlannerLoop {
  const intervalMs = requirePositiveInteger("intervalMs", input.intervalMs, MAX_TIMER_DELAY_MS);
  const batchLimit = requirePositiveInteger("batchLimit", input.batchLimit, MAX_BATCH_LIMIT);
  const now = input.now ?? (() => new Date());
  const scheduleTimeout = input.setTimeout ?? globalThis.setTimeout;
  const cancelTimeout = input.clearTimeout ?? globalThis.clearTimeout;
  let running = false;
  let timer: TimerHandle | undefined;
  let inFlight: Promise<void> | undefined;
  let latestBatch: ActionProposalPlannerBatchSnapshot | undefined;

  const tick = async () => {
    const startedAt = requireDate(now());
    try {
      const skippedByGate = !input.canRun();
      const result = skippedByGate
        ? emptyResult()
        : await input.planner.planBatch({ limit: batchLimit, at: startedAt });
      latestBatch = {
        status: "succeeded",
        startedAt,
        finishedAt: requireDate(now()),
        ...result,
        skippedByGate,
        failed: false,
      };
    } catch (error) {
      latestBatch = {
        status: "failed",
        startedAt,
        finishedAt: requireDate(now()),
        candidateCount: 0,
        plannedCount: 0,
        alreadyPlannedCount: 0,
        ineligibleCount: 0,
        failedCount: 0,
        cancelledStaleCount: 0,
        skippedByGate: false,
        failed: true,
        errorCode: "planner_failed",
      };
      try {
        input.onError?.(error);
      } catch {
        // Observability cannot interrupt planning.
      }
    }
  };
  const scheduleNext = () => {
    if (!running) return;
    timer = scheduleTimeout(() => {
      timer = undefined;
      inFlight = tick().finally(() => {
        inFlight = undefined;
        scheduleNext();
      });
    }, intervalMs);
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
    isRunning: () => running,
    getSnapshot() {
      return {
        running,
        intervalMs,
        batchLimit,
        ...(latestBatch === undefined ? {} : { latestBatch: cloneSnapshot(latestBatch) }),
      };
    },
  };
}

function emptyResult(): ActionProposalPlanBatchResult {
  return {
    candidateCount: 0,
    plannedCount: 0,
    alreadyPlannedCount: 0,
    ineligibleCount: 0,
    failedCount: 0,
    cancelledStaleCount: 0,
  };
}

function cloneSnapshot(snapshot: ActionProposalPlannerBatchSnapshot): ActionProposalPlannerBatchSnapshot {
  return {
    ...snapshot,
    startedAt: new Date(snapshot.startedAt),
    finishedAt: new Date(snapshot.finishedAt),
  };
}

function requirePositiveInteger(name: string, value: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new Error(`${name} must be between 1 and ${max}`);
  }
  return value;
}

function requireDate(value: Date): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new Error("planner loop time must be a valid date");
  }
  return new Date(value);
}
