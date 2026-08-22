import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createManagedKnowledgeUpdateExecutorLoop,
} from "../src/action-approvals/managed-knowledge-update-executor-loop.js";

describe("ManagedKnowledgeUpdateExecutorLoop", () => {
  afterEach(() => vi.useRealTimers());

  it("runs update claims and reconciliation in one non-overlapping content-free batch", async () => {
    vi.useFakeTimers();
    const executor = { processBatch: vi.fn(async () => [
      { status: "resync_required" as const, proposalId: "private-proposal", executionId: "private-execution", code: "applied" },
      { status: "skipped" as const, proposalId: "other-private-proposal", code: "claim_rejected" },
    ]) };
    const reconciler = { processBatch: vi.fn(async () => [
      { status: "reconciliation_required" as const, executionId: "private-execution", code: "human_edit" },
    ]) };
    const loop = createManagedKnowledgeUpdateExecutorLoop({
      executor,
      reconciler,
      intervalMs: 1_000,
      batchLimit: 5,
      now: () => new Date("2026-08-21T05:00:00.000Z"),
    });

    loop.start();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(executor.processBatch).toHaveBeenCalledWith({ limit: 5 });
    expect(reconciler.processBatch).toHaveBeenCalledWith({ limit: 5 });
    expect(loop.getSnapshot()).toMatchObject({
      running: true,
      latestBatch: {
        status: "succeeded",
        executionCount: 2,
        reconciliationCount: 1,
      },
    });
    expect(JSON.stringify(loop.getSnapshot())).not.toMatch(/private|proposal|executionId|human_edit/iu);
    await loop.stop();
  });

  it("still reconciles claimed uncertain work when the capability-gated executor fails", async () => {
    vi.useFakeTimers();
    const executor = { processBatch: vi.fn(async () => { throw new Error("private executor failure"); }) };
    const reconciler = { processBatch: vi.fn(async () => []) };
    const onError = vi.fn();
    const loop = createManagedKnowledgeUpdateExecutorLoop({
      executor,
      reconciler,
      intervalMs: 1_000,
      batchLimit: 1,
      onError,
    });

    loop.start();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(reconciler.processBatch).toHaveBeenCalledOnce();
    expect(loop.getSnapshot()).toMatchObject({
      latestBatch: {
        status: "partial_failed",
        executorFailed: true,
        reconcilerFailed: false,
        errorCode: "managed_update_worker_failed",
      },
    });
    expect(onError).toHaveBeenCalledOnce();
    await loop.stop();
  });
});
