import { afterEach, describe, expect, it, vi } from "vitest";

import { createApprovalInteractionWorkerLoop } from "../src/knowledge-cards/approval-interaction-worker-loop.js";

describe("ApprovalInteractionWorkerLoop", () => {
  afterEach(() => vi.useRealTimers());

  it("polls bounded batches and records status counts", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-19T03:00:00.000Z"));
    const worker = {
      processBatch: vi.fn(async () => [
        { status: "applied" as const, idempotencyKey: "event-1", code: "action_applied" as const },
        { status: "denied" as const, idempotencyKey: "event-2", code: "bot_actor" as const },
        { status: "retrying" as const, idempotencyKey: "event-3", code: "membership_unavailable" as const },
        { status: "dead_lettered" as const, idempotencyKey: "event-4", code: "repository_unavailable" as const },
      ]),
    };
    const loop = createApprovalInteractionWorkerLoop({ worker, intervalMs: 1000, batchLimit: 25 });

    loop.start();
    await vi.runOnlyPendingTimersAsync();

    expect(worker.processBatch).toHaveBeenCalledWith({ limit: 25 });
    expect(loop.getSnapshot()).toEqual({
      running: true,
      intervalMs: 1000,
      batchLimit: 25,
      latestBatch: {
        status: "succeeded",
        startedAt: new Date("2026-07-19T03:00:01.000Z"),
        finishedAt: new Date("2026-07-19T03:00:01.000Z"),
        appliedCount: 1,
        alreadyAppliedCount: 0,
        deniedCount: 1,
        retryingCount: 1,
        deadLetteredCount: 1,
        failed: false,
      },
    });
    await loop.stop();
  });

  it("does not overlap ticks and stop waits for the in-flight batch", async () => {
    vi.useFakeTimers();
    let resolveBatch: (() => void) | undefined;
    const worker = {
      processBatch: vi.fn(() => new Promise<[]>((resolve) => { resolveBatch = () => resolve([]); })),
    };
    const loop = createApprovalInteractionWorkerLoop({ worker, intervalMs: 1000, batchLimit: 10 });

    loop.start();
    await vi.runOnlyPendingTimersAsync();
    await vi.advanceTimersByTimeAsync(5000);
    const stopping = loop.stop();

    expect(worker.processBatch).toHaveBeenCalledOnce();
    expect(loop.isRunning()).toBe(false);
    let stopped = false;
    void stopping.then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    resolveBatch?.();
    await stopping;
    expect(stopped).toBe(true);
  });

  it("records bounded errors and continues polling", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-19T03:00:00.000Z"));
    const error = new Error(`${"E".repeat(1200)} private tail`);
    const worker = { processBatch: vi.fn().mockRejectedValueOnce(error).mockResolvedValueOnce([]) };
    const onError = vi.fn();
    const loop = createApprovalInteractionWorkerLoop({
      worker,
      intervalMs: 1000,
      batchLimit: 10,
      onError,
    });

    loop.start();
    await vi.runOnlyPendingTimersAsync();
    const failed = loop.getSnapshot().latestBatch;
    expect(failed?.status).toBe("failed");
    if (failed?.status !== "failed") throw new Error("expected failed snapshot");
    expect(failed.errorMessage.length).toBeLessThanOrEqual(1000);
    expect(failed.errorMessage).toContain("[truncated]");
    expect(failed.errorMessage).not.toContain("private tail");
    expect(onError).toHaveBeenCalledWith(error);

    await vi.advanceTimersByTimeAsync(1000);
    expect(worker.processBatch).toHaveBeenCalledTimes(2);
    expect(loop.getSnapshot().latestBatch).toMatchObject({ status: "succeeded", failed: false });
    await loop.stop();
  });

  it("returns snapshots that cannot mutate loop state", async () => {
    vi.useFakeTimers();
    const worker = { processBatch: vi.fn(async () => []) };
    const loop = createApprovalInteractionWorkerLoop({ worker, intervalMs: 1000, batchLimit: 10 });
    loop.start();
    await vi.runOnlyPendingTimersAsync();

    const snapshot = loop.getSnapshot();
    if (snapshot.latestBatch?.status !== "succeeded") throw new Error("expected succeeded snapshot");
    snapshot.latestBatch.startedAt.setUTCFullYear(2035);
    snapshot.latestBatch.appliedCount = 99;

    expect(loop.getSnapshot().latestBatch).toMatchObject({ appliedCount: 0 });
    expect(loop.getSnapshot().latestBatch?.startedAt.getUTCFullYear()).not.toBe(2035);
    await loop.stop();
  });

  it("rejects unsafe loop controls", () => {
    const worker = { processBatch: vi.fn(async () => []) };
    expect(() => createApprovalInteractionWorkerLoop({
      worker,
      intervalMs: 2_147_483_648,
      batchLimit: 10,
    })).toThrow("intervalMs must not exceed 2147483647");
    expect(() => createApprovalInteractionWorkerLoop({
      worker,
      intervalMs: 1000,
      batchLimit: 101,
    })).toThrow("batchLimit must not exceed 100");
  });
});
