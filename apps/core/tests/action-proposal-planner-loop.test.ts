import { afterEach, describe, expect, it, vi } from "vitest";

import { createActionProposalPlannerLoop } from "../src/action-approvals/action-proposal-planner-loop.js";

const emptyResult = {
  candidateCount: 0,
  plannedCount: 0,
  alreadyPlannedCount: 0,
  ineligibleCount: 0,
  failedCount: 0,
  cancelledStaleCount: 0,
};

describe("ActionProposalPlannerLoop", () => {
  afterEach(() => vi.useRealTimers());

  it("runs bounded batches only while the composite runtime gate permits planning", async () => {
    vi.useFakeTimers();
    let enabled = false;
    const planner = { planBatch: vi.fn(async () => ({ ...emptyResult, plannedCount: 2 })) };
    const loop = createActionProposalPlannerLoop({
      planner,
      canRun: () => enabled,
      intervalMs: 1_000,
      batchLimit: 20,
    });

    loop.start();
    await vi.runOnlyPendingTimersAsync();
    expect(planner.planBatch).not.toHaveBeenCalled();
    enabled = true;
    await vi.advanceTimersByTimeAsync(1_000);

    expect(planner.planBatch).toHaveBeenCalledWith({
      limit: 20,
      at: expect.any(Date),
    });
    expect(loop.getSnapshot()).toMatchObject({
      running: true,
      latestBatch: {
        status: "succeeded",
        skippedByGate: false,
        plannedCount: 2,
      },
    });
    await loop.stop();
  });

  it("isolates content-bearing failures and continues without overlapping", async () => {
    vi.useFakeTimers();
    let resolveBatch: ((value: typeof emptyResult) => void) | undefined;
    const planner = {
      planBatch: vi.fn()
        .mockRejectedValueOnce(new Error("draft body bearer_secret ou_actor"))
        .mockImplementationOnce(() => new Promise<typeof emptyResult>((resolve) => {
          resolveBatch = resolve;
        })),
    };
    const onError = vi.fn();
    const loop = createActionProposalPlannerLoop({
      planner,
      canRun: () => true,
      intervalMs: 1_000,
      batchLimit: 10,
      onError,
    });

    loop.start();
    await vi.runOnlyPendingTimersAsync();
    const failed = loop.getSnapshot().latestBatch;
    expect(failed).toMatchObject({ status: "failed", errorCode: "planner_failed" });
    expect(JSON.stringify(failed)).not.toMatch(/draft body|bearer|ou_actor/iu);
    expect(onError).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(planner.planBatch).toHaveBeenCalledTimes(2);
    const stopping = loop.stop();
    resolveBatch?.(emptyResult);
    await stopping;
  });

  it("rejects unsafe interval and batch controls", () => {
    const planner = { planBatch: vi.fn(async () => emptyResult) };
    expect(() => createActionProposalPlannerLoop({
      planner,
      canRun: () => true,
      intervalMs: 0,
      batchLimit: 10,
    })).toThrow(/intervalMs/iu);
    expect(() => createActionProposalPlannerLoop({
      planner,
      canRun: () => true,
      intervalMs: 1_000,
      batchLimit: 101,
    })).toThrow(/batchLimit/iu);
  });
});
