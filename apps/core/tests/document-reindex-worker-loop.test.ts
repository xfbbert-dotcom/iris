import { afterEach, describe, expect, it, vi } from "vitest";

import { createDocumentReindexWorkerLoop } from "../src/reindex/document-reindex-worker-loop.js";

describe("DocumentReindexWorkerLoop", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("polls the worker after start", async () => {
    vi.useFakeTimers();
    const worker = { processBatch: vi.fn(async () => []) };
    const loop = createDocumentReindexWorkerLoop({
      worker,
      intervalMs: 1000,
      batchLimit: 25,
    });

    loop.start();
    await vi.runOnlyPendingTimersAsync();

    expect(worker.processBatch).toHaveBeenCalledWith({ limit: 25 });
    expect(loop.getSnapshot()).toMatchObject({
      running: true,
      intervalMs: 1000,
      batchLimit: 25,
    });
    await loop.stop();
  });

  it("rejects unsafe interval and batch limit values", () => {
    const worker = { processBatch: vi.fn(async () => []) };

    expect(() =>
      createDocumentReindexWorkerLoop({
        worker,
        intervalMs: 9007199254740992,
        batchLimit: 25,
      }),
    ).toThrow("intervalMs must be a positive safe integer");
    expect(() =>
      createDocumentReindexWorkerLoop({
        worker,
        intervalMs: 1000,
        batchLimit: 9007199254740992,
      }),
    ).toThrow("batchLimit must be a positive safe integer");
    expect(() =>
      createDocumentReindexWorkerLoop({
        worker,
        intervalMs: 2_147_483_648,
        batchLimit: 25,
      }),
    ).toThrow("intervalMs must not exceed 2147483647");
  });

  it("does not create duplicate loops on repeated start", async () => {
    vi.useFakeTimers();
    const worker = { processBatch: vi.fn(async () => []) };
    const loop = createDocumentReindexWorkerLoop({
      worker,
      intervalMs: 1000,
      batchLimit: 25,
    });

    loop.start();
    loop.start();
    await vi.runOnlyPendingTimersAsync();

    expect(worker.processBatch).toHaveBeenCalledTimes(1);
    await loop.stop();
  });

  it("stops future ticks", async () => {
    vi.useFakeTimers();
    const worker = { processBatch: vi.fn(async () => []) };
    const loop = createDocumentReindexWorkerLoop({
      worker,
      intervalMs: 1000,
      batchLimit: 25,
    });

    loop.start();
    await loop.stop();
    await vi.runOnlyPendingTimersAsync();

    expect(worker.processBatch).not.toHaveBeenCalled();
  });

  it("reports errors and continues polling", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-02T01:00:00.000Z"));
    const error = new Error("batch failed");
    const worker = {
      processBatch: vi.fn().mockRejectedValueOnce(error).mockResolvedValueOnce([]),
    };
    const onError = vi.fn();
    const loop = createDocumentReindexWorkerLoop({
      worker,
      intervalMs: 1000,
      batchLimit: 25,
      onError,
    });

    loop.start();
    await vi.runOnlyPendingTimersAsync();
    await vi.advanceTimersByTimeAsync(1000);

    expect(onError).toHaveBeenCalledWith(error);
    expect(worker.processBatch).toHaveBeenCalledTimes(2);
    expect(loop.getSnapshot().latestBatch).toMatchObject({
      status: "succeeded",
      indexedCount: 0,
      skippedCount: 0,
      failedCount: 0,
      failed: false,
    });
    await loop.stop();
  });

  it("isolates throwing error hooks and continues polling", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-02T01:00:00.000Z"));
    const error = new Error("batch failed");
    const worker = {
      processBatch: vi.fn().mockRejectedValueOnce(error).mockResolvedValueOnce([]),
    };
    const onError = vi.fn(() => {
      throw new Error("observer failed");
    });
    const loop = createDocumentReindexWorkerLoop({
      worker,
      intervalMs: 1000,
      batchLimit: 25,
      onError,
    });

    loop.start();
    await vi.runOnlyPendingTimersAsync();

    expect(onError).toHaveBeenCalledWith(error);
    expect(loop.getSnapshot().latestBatch).toMatchObject({
      status: "failed",
      errorMessage: "batch failed",
      failed: true,
    });

    await vi.advanceTimersByTimeAsync(1000);
    expect(worker.processBatch).toHaveBeenCalledTimes(2);
    await loop.stop();
  });

  it("records successful batch result counts", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-02T01:00:00.000Z"));
    const worker = {
      processBatch: vi.fn(async () => [
        {
          status: "failed" as const,
          documentSnapshotId: "snapshot-3",
          embeddingProfileId: "profile-1",
          reason: "processing_error" as const,
          errorMessage: "embedding failed",
          retryAction: "requeued" as const,
          attempts: 1,
        },
        {
          status: "indexed" as const,
          documentSnapshotId: "snapshot-1",
          embeddingProfileId: "profile-1",
          fragmentCount: 2,
        },
        {
          status: "skipped" as const,
          documentSnapshotId: "snapshot-2",
          embeddingProfileId: "profile-1",
          reason: "already_indexed" as const,
        },
      ]),
    };
    const loop = createDocumentReindexWorkerLoop({
      worker,
      intervalMs: 1000,
      batchLimit: 25,
    });

    loop.start();
    await vi.runOnlyPendingTimersAsync();

    expect(loop.getSnapshot().latestBatch).toEqual({
      status: "succeeded",
      startedAt: new Date("2026-07-02T01:00:01.000Z"),
      finishedAt: new Date("2026-07-02T01:00:01.000Z"),
      indexedCount: 1,
      skippedCount: 1,
      failedCount: 1,
      failed: false,
    });
    await loop.stop();
  });

  it("returns latest batch snapshots that cannot mutate loop state", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-02T01:00:00.000Z"));
    const worker = {
      processBatch: vi.fn(async () => [
        {
          status: "indexed" as const,
          documentSnapshotId: "snapshot-1",
          embeddingProfileId: "profile-1",
          fragmentCount: 2,
        },
      ]),
    };
    const loop = createDocumentReindexWorkerLoop({
      worker,
      intervalMs: 1000,
      batchLimit: 25,
    });

    loop.start();
    await vi.runOnlyPendingTimersAsync();

    const firstSnapshot = loop.getSnapshot();
    expect(firstSnapshot.latestBatch?.status).toBe("succeeded");
    if (firstSnapshot.latestBatch?.status !== "succeeded") {
      throw new Error("expected succeeded batch snapshot");
    }

    firstSnapshot.latestBatch.startedAt.setUTCFullYear(2030);
    firstSnapshot.latestBatch.finishedAt.setUTCFullYear(2030);
    firstSnapshot.latestBatch.indexedCount = 999;

    expect(loop.getSnapshot().latestBatch).toEqual({
      status: "succeeded",
      startedAt: new Date("2026-07-02T01:00:01.000Z"),
      finishedAt: new Date("2026-07-02T01:00:01.000Z"),
      indexedCount: 1,
      skippedCount: 0,
      failedCount: 0,
      failed: false,
    });
    await loop.stop();
  });

  it("records failed batch errors", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-02T01:00:00.000Z"));
    const worker = {
      processBatch: vi.fn(async () => {
        throw new Error("batch failed");
      }),
    };
    const loop = createDocumentReindexWorkerLoop({
      worker,
      intervalMs: 1000,
      batchLimit: 25,
    });

    loop.start();
    await vi.runOnlyPendingTimersAsync();

    expect(loop.getSnapshot().latestBatch).toEqual({
      status: "failed",
      startedAt: new Date("2026-07-02T01:00:01.000Z"),
      finishedAt: new Date("2026-07-02T01:00:01.000Z"),
      indexedCount: 0,
      skippedCount: 0,
      failedCount: 0,
      failed: true,
      errorMessage: "batch failed",
    });
    await loop.stop();
  });

  it("bounds failed batch error messages in loop snapshots", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-02T01:00:00.000Z"));
    const oversizedMessage = `${"E".repeat(1200)} trailing diagnostic detail`;
    const worker = {
      processBatch: vi.fn(async () => {
        throw new Error(oversizedMessage);
      }),
    };
    const loop = createDocumentReindexWorkerLoop({
      worker,
      intervalMs: 1000,
      batchLimit: 25,
    });

    loop.start();
    await vi.runOnlyPendingTimersAsync();

    const latestBatch = loop.getSnapshot().latestBatch;
    expect(latestBatch?.status).toBe("failed");
    if (latestBatch?.status !== "failed") {
      throw new Error("expected failed batch snapshot");
    }
    expect(latestBatch.errorMessage.length).toBeLessThanOrEqual(1000);
    expect(latestBatch.errorMessage).toContain("[truncated]");
    expect(latestBatch.errorMessage).not.toContain("trailing diagnostic detail");
    await loop.stop();
  });

  it("does not overlap long-running batches", async () => {
    vi.useFakeTimers();
    let resolveBatch: (() => void) | undefined;
    const worker = {
      processBatch: vi.fn(
        () =>
          new Promise<[]>((resolve) => {
            resolveBatch = () => resolve([]);
          }),
      ),
    };
    const loop = createDocumentReindexWorkerLoop({
      worker,
      intervalMs: 1000,
      batchLimit: 25,
    });

    loop.start();
    await vi.runOnlyPendingTimersAsync();
    await vi.advanceTimersByTimeAsync(5000);

    expect(worker.processBatch).toHaveBeenCalledTimes(1);
    resolveBatch?.();
    await loop.stop();
  });
});
