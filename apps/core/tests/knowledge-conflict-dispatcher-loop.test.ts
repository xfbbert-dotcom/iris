import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createKnowledgeConflictDispatcherLoop,
} from "../src/knowledge-conflicts/knowledge-conflict-dispatcher-loop.js";

describe("KnowledgeConflictDispatcherLoop", () => {
  afterEach(() => vi.useRealTimers());

  it("polls bounded batches and snapshots only content-free delivery outcomes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-15T03:00:00.000Z"));
    const worker = {
      processBatch: vi.fn(async () => [
        { status: "sent" as const, deliveryId: "delivery-1", code: "send_succeeded" as const },
        { status: "retrying" as const, deliveryId: "delivery-2", code: "request_not_sent" as const },
        { status: "permanent_failure" as const, deliveryId: "delivery-3", code: "remote_rejected" as const },
        { status: "outcome_unknown" as const, deliveryId: "delivery-4", code: "outcome_unknown" as const },
      ]),
    };
    const loop = createKnowledgeConflictDispatcherLoop({
      worker,
      intervalMs: 1_000,
      batchLimit: 20,
    });

    loop.start();
    await vi.runOnlyPendingTimersAsync();

    expect(worker.processBatch).toHaveBeenCalledWith({ limit: 20 });
    expect(loop.getSnapshot()).toEqual({
      running: true,
      intervalMs: 1_000,
      batchLimit: 20,
      latestBatch: {
        status: "succeeded",
        startedAt: new Date("2026-08-15T03:00:01.000Z"),
        finishedAt: new Date("2026-08-15T03:00:01.000Z"),
        sentCount: 1,
        retryingCount: 1,
        permanentFailureCount: 1,
        outcomeUnknownCount: 1,
        failed: false,
      },
    });
    expect(JSON.stringify(loop.getSnapshot())).not.toMatch(/delivery-[1-4]|statement|actor|token/iu);
    await loop.stop();
  });

  it("does not overlap and stops after an in-flight batch", async () => {
    vi.useFakeTimers();
    let resolveBatch: (() => void) | undefined;
    const worker = {
      processBatch: vi.fn(() => new Promise<[]>((resolve) => { resolveBatch = () => resolve([]); })),
    };
    const loop = createKnowledgeConflictDispatcherLoop({ worker, intervalMs: 1_000, batchLimit: 10 });

    loop.start();
    await vi.runOnlyPendingTimersAsync();
    await vi.advanceTimersByTimeAsync(5_000);
    const stopping = loop.stop();

    expect(worker.processBatch).toHaveBeenCalledOnce();
    expect(loop.isRunning()).toBe(false);
    resolveBatch?.();
    await stopping;
  });

  it("contains raw worker errors, isolates observers, and continues", async () => {
    vi.useFakeTimers();
    const raw = new Error("conflict statement ou_actor bearer_secret");
    const worker = { processBatch: vi.fn().mockRejectedValueOnce(raw).mockResolvedValueOnce([]) };
    const onError = vi.fn(() => { throw new Error("observer failure"); });
    const loop = createKnowledgeConflictDispatcherLoop({
      worker,
      intervalMs: 1_000,
      batchLimit: 10,
      onError,
    });

    loop.start();
    await vi.runOnlyPendingTimersAsync();

    expect(loop.getSnapshot().latestBatch).toMatchObject({
      status: "failed",
      errorCode: "worker_failed",
      failed: true,
    });
    expect(JSON.stringify(loop.getSnapshot())).not.toMatch(/conflict statement|ou_actor|bearer_secret/iu);
    expect(onError).toHaveBeenCalledWith(raw);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(worker.processBatch).toHaveBeenCalledTimes(2);
    await loop.stop();
  });

  it("clones snapshots and rejects unsafe controls", async () => {
    vi.useFakeTimers();
    const worker = { processBatch: vi.fn(async () => []) };
    const loop = createKnowledgeConflictDispatcherLoop({ worker, intervalMs: 1_000, batchLimit: 10 });
    loop.start();
    await vi.runOnlyPendingTimersAsync();
    const snapshot = loop.getSnapshot();
    if (snapshot.latestBatch?.status !== "succeeded") throw new Error("expected success");
    snapshot.latestBatch.startedAt.setUTCFullYear(2035);
    snapshot.latestBatch.sentCount = 99;
    expect(loop.getSnapshot().latestBatch).toMatchObject({ sentCount: 0 });
    expect(loop.getSnapshot().latestBatch?.startedAt.getUTCFullYear()).not.toBe(2035);
    await loop.stop();

    expect(() => createKnowledgeConflictDispatcherLoop({
      worker,
      intervalMs: 2_147_483_648,
      batchLimit: 10,
    })).toThrow("intervalMs must not exceed 2147483647");
    expect(() => createKnowledgeConflictDispatcherLoop({
      worker,
      intervalMs: 1_000,
      batchLimit: 101,
    })).toThrow("batchLimit must not exceed 100");
  });
});
