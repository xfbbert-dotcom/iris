import { afterEach, describe, expect, it, vi } from "vitest";

import { createRawEventWorkerLoop } from "../src/events/raw-event-worker-loop.js";

describe("RawEventWorkerLoop", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("polls the worker after start", async () => {
    vi.useFakeTimers();
    const worker = { processBatch: vi.fn(async () => []) };
    const loop = createRawEventWorkerLoop({
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
      createRawEventWorkerLoop({
        worker,
        intervalMs: 9007199254740992,
        batchLimit: 25,
      }),
    ).toThrow("intervalMs must be a positive safe integer");
    expect(() =>
      createRawEventWorkerLoop({
        worker,
        intervalMs: 1000,
        batchLimit: 9007199254740992,
      }),
    ).toThrow("batchLimit must be a positive safe integer");
    expect(() =>
      createRawEventWorkerLoop({
        worker,
        intervalMs: 2_147_483_648,
        batchLimit: 25,
      }),
    ).toThrow("intervalMs must not exceed 2147483647");
  });

  it("records successful batch result counts", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-02T01:00:00.000Z"));
    const worker = {
      processBatch: vi.fn(async () => [
        {
          status: "processed" as const,
          idempotencyKey: "raw-event:feishu:event-1",
          eventType: "im.message.receive_v1",
        },
        {
          status: "failed" as const,
          idempotencyKey: "raw-event:feishu:event-2",
          eventType: "im.message.receive_v1",
          errorMessage: "processor failed",
          retryAction: "requeued" as const,
          attempts: 1,
        },
      ]),
    };
    const loop = createRawEventWorkerLoop({
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
      processedCount: 1,
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
          status: "processed" as const,
          idempotencyKey: "raw-event:feishu:event-1",
          eventType: "im.message.receive_v1",
        },
      ]),
    };
    const loop = createRawEventWorkerLoop({
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
      startedAt: new Date("2026-07-02T01:00:01.000Z"),
      finishedAt: new Date("2026-07-02T01:00:01.000Z"),
      processedCount: 1,
      failedCount: 0,
      failed: false,
    });
    await loop.stop();
  });

  it("records failed batch errors and continues polling", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-02T01:00:00.000Z"));
    const error = new Error("batch failed");
    const worker = {
      processBatch: vi.fn().mockRejectedValueOnce(error).mockResolvedValueOnce([]),
    };
    const onError = vi.fn();
    const loop = createRawEventWorkerLoop({
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
    const loop = createRawEventWorkerLoop({
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
    const loop = createRawEventWorkerLoop({
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
