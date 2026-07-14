import { describe, expect, it, vi } from "vitest";

import { createMemoryExtractionWorkerLoop } from "../src/memory-extraction/memory-extraction-worker-loop.js";

describe("createMemoryExtractionWorkerLoop", () => {
  it("uses an abortable sleep and stop prevents a future tick", async () => {
    const sleep = controlledSleep();
    const worker = { processBatch: vi.fn(async () => []) };
    const loop = createMemoryExtractionWorkerLoop({
      worker,
      intervalMs: 1_000,
      batchLimit: 20,
      sleep: sleep.sleep,
    });

    loop.start();
    expect(sleep.calls).toHaveLength(1);
    expect(sleep.calls[0]?.signal.aborted).toBe(false);

    await loop.stop();

    expect(sleep.calls[0]?.signal.aborted).toBe(true);
    expect(worker.processBatch).not.toHaveBeenCalled();
    expect(loop.isRunning()).toBe(false);
  });

  it("never overlaps ticks or creates a second consumer on repeated start", async () => {
    const sleep = controlledSleep();
    const batch = deferred<[]>();
    const worker = { processBatch: vi.fn(() => batch.promise) };
    const loop = createMemoryExtractionWorkerLoop({
      worker,
      intervalMs: 1,
      batchLimit: 20,
      sleep: sleep.sleep,
    });

    loop.start();
    loop.start();
    expect(sleep.calls).toHaveLength(1);

    sleep.calls[0]!.resolve();
    await vi.waitFor(() => expect(worker.processBatch).toHaveBeenCalledOnce());
    expect(sleep.calls).toHaveLength(1);

    batch.resolve([]);
    await vi.waitFor(() => expect(sleep.calls).toHaveLength(2));
    expect(worker.processBatch).toHaveBeenCalledOnce();

    await loop.stop();
  });

  it("stop awaits an in-flight batch before resolving", async () => {
    const sleep = controlledSleep();
    const batch = deferred<[]>();
    const worker = { processBatch: vi.fn(() => batch.promise) };
    const loop = createMemoryExtractionWorkerLoop({
      worker,
      intervalMs: 1,
      batchLimit: 20,
      sleep: sleep.sleep,
    });
    loop.start();
    sleep.calls[0]!.resolve();
    await vi.waitFor(() => expect(worker.processBatch).toHaveBeenCalledOnce());

    let stopped = false;
    const stopping = loop.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);

    batch.resolve([]);
    await stopping;
    expect(stopped).toBe(true);
  });

  it("records cloned batch snapshots and isolates throwing observers", async () => {
    const sleep = controlledSleep();
    const worker = {
      processBatch: vi
        .fn()
        .mockResolvedValueOnce([
          { status: "completed" },
          { status: "skipped" },
          { status: "failed" },
        ])
        .mockRejectedValueOnce(new Error("memory extraction batch failed")),
    };
    const onError = vi.fn(() => {
      throw new Error("observer failed");
    });
    const times = [
      new Date("2026-07-15T00:00:00.000Z"),
      new Date("2026-07-15T00:00:01.000Z"),
      new Date("2026-07-15T00:00:02.000Z"),
      new Date("2026-07-15T00:00:03.000Z"),
    ];
    let timeIndex = 0;
    const loop = createMemoryExtractionWorkerLoop({
      worker,
      intervalMs: 1,
      batchLimit: 20,
      sleep: sleep.sleep,
      onError,
      now: () => times[timeIndex++] ?? times.at(-1)!,
    });
    loop.start();

    sleep.calls[0]!.resolve();
    await vi.waitFor(() => expect(sleep.calls).toHaveLength(2));
    const successful = loop.getSnapshot();
    expect(successful.latestBatch).toEqual({
      status: "succeeded",
      startedAt: times[0],
      finishedAt: times[1],
      completedCount: 1,
      skippedCount: 1,
      failedCount: 1,
      failed: false,
    });
    successful.latestBatch!.startedAt.setUTCFullYear(2030);
    expect(loop.getSnapshot().latestBatch?.startedAt).toEqual(times[0]);

    sleep.calls[1]!.resolve();
    await vi.waitFor(() => expect(sleep.calls).toHaveLength(3));
    expect(loop.getSnapshot().latestBatch).toEqual({
      status: "failed",
      startedAt: times[2],
      finishedAt: times[3],
      completedCount: 0,
      skippedCount: 0,
      failedCount: 0,
      failed: true,
      errorMessage: "memory extraction batch failed",
    });
    expect(onError).toHaveBeenCalledOnce();

    await loop.stop();
  });

  it("rejects unsafe timer and batch bounds before starting", () => {
    const worker = { processBatch: vi.fn(async () => []) };
    const values = [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1];
    for (const intervalMs of values) {
      expect(() =>
        createMemoryExtractionWorkerLoop({ worker, intervalMs, batchLimit: 20 }),
      ).toThrow();
    }
    expect(() =>
      createMemoryExtractionWorkerLoop({
        worker,
        intervalMs: 2_147_483_648,
        batchLimit: 20,
      }),
    ).toThrow("intervalMs must not exceed 2147483647");
    for (const batchLimit of [0, -1, 1.5, 101, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() =>
        createMemoryExtractionWorkerLoop({ worker, intervalMs: 1, batchLimit }),
      ).toThrow();
    }
  });
});

function controlledSleep() {
  const calls: Array<{
    milliseconds: number;
    signal: AbortSignal;
    resolve(): void;
  }> = [];
  const sleep = vi.fn((milliseconds: number, signal: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      calls.push({
        milliseconds,
        signal,
        resolve() {
          signal.removeEventListener("abort", onAbort);
          resolve();
        },
      });
    }),
  );
  return { calls, sleep };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
