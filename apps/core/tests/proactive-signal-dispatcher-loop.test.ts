import { describe, expect, it, vi } from "vitest";

import { createProactiveSignalDispatcherLoop } from "../src/proactive-signals/proactive-signal-dispatcher-loop.js";

describe("ProactiveSignalDispatcherLoop", () => {
  it("runs bounded non-overlapping batches and records content-free counts", async () => {
    vi.useFakeTimers();
    try {
      const worker = { processBatch: vi.fn(async () => [
        { status: "sent" as const, deliveryId: "delivery-a", code: "send_succeeded" as const },
        { status: "retrying" as const, deliveryId: "delivery-b", code: "request_not_sent" as const },
      ]) };
      const loop = createProactiveSignalDispatcherLoop({
        worker,
        intervalMs: 1_000,
        batchLimit: 5,
        now: () => new Date("2026-07-23T10:00:00.000Z"),
      });
      loop.start();
      await vi.advanceTimersByTimeAsync(1_000);

      expect(worker.processBatch).toHaveBeenCalledWith({ limit: 5 });
      expect(loop.getSnapshot()).toMatchObject({
        running: true,
        latestBatch: {
          status: "succeeded",
          sentCount: 1,
          retryingCount: 1,
          permanentFailureCount: 0,
          outcomeUnknownCount: 0,
        },
      });
      expect(JSON.stringify(loop.getSnapshot())).not.toMatch(/delivery-a|delivery-b/u);
      await loop.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("isolates worker failure and stops cleanly", async () => {
    vi.useFakeTimers();
    try {
      const onError = vi.fn();
      const loop = createProactiveSignalDispatcherLoop({
        worker: { processBatch: vi.fn(async () => { throw new Error("private failure"); }) },
        intervalMs: 1_000,
        batchLimit: 1,
        onError,
      });
      loop.start();
      await vi.advanceTimersByTimeAsync(1_000);

      expect(loop.getSnapshot()).toMatchObject({
        latestBatch: { status: "failed", errorCode: "worker_failed" },
      });
      expect(JSON.stringify(loop.getSnapshot())).not.toContain("private failure");
      expect(onError).toHaveBeenCalledOnce();
      await loop.stop();
      expect(loop.isRunning()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
