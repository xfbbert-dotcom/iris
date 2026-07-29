import { afterEach, describe, expect, it, vi } from "vitest";

import { createWikiSpaceSyncWorkerLoop } from "../src/documents/wiki-space-sync-worker-loop.js";

describe("WikiSpaceSyncWorkerLoop", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts idempotently and processes one authorization per scheduled tick", async () => {
    vi.useFakeTimers();
    const worker = { processNext: vi.fn(async () => ({ status: "idle" as const })) };
    const loop = createWikiSpaceSyncWorkerLoop({ worker, intervalMs: 1_000 });

    loop.start();
    loop.start();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(worker.processNext).toHaveBeenCalledTimes(1);
    expect(loop.isRunning()).toBe(true);
    await loop.stop();
  });

  it("stops a pending tick before it runs", async () => {
    vi.useFakeTimers();
    const worker = { processNext: vi.fn(async () => ({ status: "idle" as const })) };
    const loop = createWikiSpaceSyncWorkerLoop({ worker, intervalMs: 1_000 });

    loop.start();
    await loop.stop();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(loop.isRunning()).toBe(false);
    expect(worker.processNext).not.toHaveBeenCalled();
  });

  it("does not overlap ticks while a scan is still in flight", async () => {
    vi.useFakeTimers();
    let resolveScan: (() => void) | undefined;
    const worker = {
      processNext: vi.fn(
        () => new Promise<{ status: "idle" }>((resolve) => {
          resolveScan = () => resolve({ status: "idle" });
        }),
      ),
    };
    const loop = createWikiSpaceSyncWorkerLoop({ worker, intervalMs: 1_000 });

    loop.start();
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(worker.processNext).toHaveBeenCalledTimes(1);
    resolveScan?.();
    await loop.stop();
  });

  it("keeps the latest result in an isolated batch snapshot", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-29T02:00:00.000Z"));
    const worker = {
      processNext: vi.fn(async () => ({
        status: "synced" as const,
        authorizationId: "authorization-1",
        registeredDocumentCount: 3,
        skippedNodeCount: 1,
      })),
    };
    const loop = createWikiSpaceSyncWorkerLoop({ worker, intervalMs: 1_000 });

    loop.start();
    await vi.advanceTimersByTimeAsync(1_000);

    const snapshot = loop.getSnapshot();
    expect(snapshot).toEqual({
      running: true,
      intervalMs: 1_000,
      latestBatch: {
        status: "succeeded",
        startedAt: new Date("2026-07-29T02:00:01.000Z"),
        finishedAt: new Date("2026-07-29T02:00:01.000Z"),
        result: {
          status: "synced",
          authorizationId: "authorization-1",
          registeredDocumentCount: 3,
          skippedNodeCount: 1,
        },
        failed: false,
      },
    });
    if (snapshot.latestBatch?.status !== "succeeded") throw new Error("expected successful batch");
    snapshot.latestBatch.startedAt.setUTCFullYear(2030);
    snapshot.latestBatch.result = { status: "idle" };
    expect(loop.getSnapshot().latestBatch).toMatchObject({
      status: "succeeded",
      startedAt: new Date("2026-07-29T02:00:01.000Z"),
      result: { status: "synced", authorizationId: "authorization-1" },
    });
    await loop.stop();
  });

  it("reduces loop errors to a safe classification before exposing them", async () => {
    vi.useFakeTimers();
    const worker = {
      processNext: vi.fn(async () => {
        throw new Error("private upstream response with credentials");
      }),
    };
    const onError = vi.fn();
    const loop = createWikiSpaceSyncWorkerLoop({ worker, intervalMs: 1_000, onError });

    loop.start();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(loop.getSnapshot().latestBatch).toMatchObject({
      status: "failed",
      classification: "internal_error",
      failed: true,
    });
    expect(JSON.stringify(loop.getSnapshot())).not.toContain("credentials");
    expect(onError).toHaveBeenCalledWith("internal_error");
    await loop.stop();
  });
});
