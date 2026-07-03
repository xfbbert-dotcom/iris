import { afterEach, describe, expect, it, vi } from "vitest";

import { createDocumentSyncWorkerLoop } from "../src/documents/document-sync-worker-loop.js";

describe("DocumentSyncWorkerLoop", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("polls the worker after start", async () => {
    vi.useFakeTimers();
    const worker = { processBatch: vi.fn(async () => []) };
    const loop = createDocumentSyncWorkerLoop({
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

  it("records successful batch result counts", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-03T02:00:00.000Z"));
    const worker = {
      processBatch: vi.fn(async () => [
        {
          status: "processed" as const,
          idempotencyKey: "document-sync:source-1",
          documentSourceId: "source-1",
          syncStatus: "synced" as const,
        },
        {
          status: "failed" as const,
          idempotencyKey: "document-sync:source-2",
          documentSourceId: "source-2",
          errorMessage: "runner crashed",
          retryAction: "requeued" as const,
          attempts: 1,
        },
      ]),
    };
    const loop = createDocumentSyncWorkerLoop({
      worker,
      intervalMs: 1000,
      batchLimit: 25,
    });

    loop.start();
    await vi.runOnlyPendingTimersAsync();

    expect(loop.getSnapshot().latestBatch).toEqual({
      status: "succeeded",
      startedAt: new Date("2026-07-03T02:00:01.000Z"),
      finishedAt: new Date("2026-07-03T02:00:01.000Z"),
      processedCount: 1,
      failedCount: 1,
      failed: false,
    });
    await loop.stop();
  });

  it("returns latest batch snapshots that cannot mutate loop state", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-03T02:00:00.000Z"));
    const worker = {
      processBatch: vi.fn(async () => [
        {
          status: "processed" as const,
          idempotencyKey: "document-sync:source-1",
          documentSourceId: "source-1",
          syncStatus: "synced" as const,
        },
      ]),
    };
    const loop = createDocumentSyncWorkerLoop({
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
    firstSnapshot.latestBatch.processedCount = 999;

    expect(loop.getSnapshot().latestBatch).toEqual({
      status: "succeeded",
      startedAt: new Date("2026-07-03T02:00:01.000Z"),
      finishedAt: new Date("2026-07-03T02:00:01.000Z"),
      processedCount: 1,
      failedCount: 0,
      failed: false,
    });
    await loop.stop();
  });

  it("records failed batch errors and continues polling", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-03T02:00:00.000Z"));
    const error = new Error("batch failed");
    const worker = {
      processBatch: vi.fn().mockRejectedValueOnce(error).mockResolvedValueOnce([]),
    };
    const onError = vi.fn();
    const loop = createDocumentSyncWorkerLoop({
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
      processedCount: 0,
      failedCount: 0,
      failed: false,
    });
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
    const loop = createDocumentSyncWorkerLoop({
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
