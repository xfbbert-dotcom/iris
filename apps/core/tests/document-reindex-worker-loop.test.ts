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
    await loop.stop();
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
