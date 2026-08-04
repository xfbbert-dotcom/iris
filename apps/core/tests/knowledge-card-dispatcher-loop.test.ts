import { afterEach, describe, expect, it, vi } from "vitest";

import { createKnowledgeCardDispatcherLoop } from "../src/knowledge-cards/knowledge-card-dispatcher-loop.js";

describe("KnowledgeCardDispatcherLoop", () => {
  afterEach(() => vi.useRealTimers());

  it("polls bounded batches and snapshots dispatcher outcomes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-19T05:00:00.000Z"));
    const worker = {
      processBatch: vi.fn(async () => [
        { status: "sent" as const, presentationId: "p1", code: "send_succeeded" as const },
        { status: "updated" as const, presentationId: "p2", code: "card_update_succeeded" as const },
        { status: "retrying" as const, presentationId: "p3", code: "request_not_sent" as const },
        { status: "permanent_failure" as const, presentationId: "p4", code: "remote_rejected" as const },
        { status: "outcome_unknown" as const, presentationId: "p5", code: "outcome_unknown" as const },
      ]),
    };
    const loop = createKnowledgeCardDispatcherLoop({ worker, intervalMs: 1000, batchLimit: 20 });

    loop.start();
    await vi.runOnlyPendingTimersAsync();

    expect(worker.processBatch).toHaveBeenCalledWith({ limit: 20 });
    expect(loop.getSnapshot()).toEqual({
      running: true,
      intervalMs: 1000,
      batchLimit: 20,
      latestBatch: {
        status: "succeeded",
        startedAt: new Date("2026-07-19T05:00:01.000Z"),
        finishedAt: new Date("2026-07-19T05:00:01.000Z"),
        sentCount: 1,
        updatedCount: 1,
        retryingCount: 1,
        permanentFailureCount: 1,
        outcomeUnknownCount: 1,
        failed: false,
      },
    });
    await loop.stop();
  });

  it("does not overlap and stops cleanly after an in-flight batch", async () => {
    vi.useFakeTimers();
    let resolveBatch: (() => void) | undefined;
    const worker = {
      processBatch: vi.fn(() => new Promise<[]>((resolve) => { resolveBatch = () => resolve([]); })),
    };
    const loop = createKnowledgeCardDispatcherLoop({ worker, intervalMs: 1000, batchLimit: 10 });

    loop.start();
    await vi.runOnlyPendingTimersAsync();
    await vi.advanceTimersByTimeAsync(5000);
    const stopping = loop.stop();

    expect(worker.processBatch).toHaveBeenCalledOnce();
    expect(loop.isRunning()).toBe(false);
    resolveBatch?.();
    await stopping;
  });

  it("uses a content-free error category, isolates observers, and continues", async () => {
    vi.useFakeTimers();
    const error = new Error("draft body ou_actor rejection reason bearer_token_secret");
    const worker = { processBatch: vi.fn().mockRejectedValueOnce(error).mockResolvedValueOnce([]) };
    const onError = vi.fn(() => { throw new Error("observer failed"); });
    const loop = createKnowledgeCardDispatcherLoop({
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
    expect(failed).toMatchObject({ errorCode: "worker_failed" });
    expect(failed).not.toHaveProperty("errorMessage");
    expect(JSON.stringify(failed)).not.toMatch(/draft body|ou_actor|rejection reason|bearer_token/iu);
    expect(onError).toHaveBeenCalledWith(error);

    await vi.advanceTimersByTimeAsync(1000);
    expect(worker.processBatch).toHaveBeenCalledTimes(2);
    await loop.stop();
  });

  it("clones snapshots and rejects unsafe controls", async () => {
    vi.useFakeTimers();
    const worker = { processBatch: vi.fn(async () => []) };
    const loop = createKnowledgeCardDispatcherLoop({ worker, intervalMs: 1000, batchLimit: 10 });
    loop.start();
    await vi.runOnlyPendingTimersAsync();
    const snapshot = loop.getSnapshot();
    if (snapshot.latestBatch?.status !== "succeeded") throw new Error("expected success");
    snapshot.latestBatch.startedAt.setUTCFullYear(2035);
    snapshot.latestBatch.sentCount = 99;
    expect(loop.getSnapshot().latestBatch).toMatchObject({ sentCount: 0 });
    expect(loop.getSnapshot().latestBatch?.startedAt.getUTCFullYear()).not.toBe(2035);
    await loop.stop();

    expect(() => createKnowledgeCardDispatcherLoop({
      worker,
      intervalMs: 2_147_483_648,
      batchLimit: 10,
    })).toThrow("intervalMs must not exceed 2147483647");
    expect(() => createKnowledgeCardDispatcherLoop({
      worker,
      intervalMs: 1000,
      batchLimit: 101,
    })).toThrow("batchLimit must not exceed 100");
  });
});
