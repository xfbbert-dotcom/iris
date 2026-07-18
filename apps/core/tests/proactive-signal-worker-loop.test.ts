import { describe, expect, it, vi } from "vitest";

import { createProactiveSignalWorkerLoop } from "../src/proactive/proactive-signal-worker-loop.js";

describe("createProactiveSignalWorkerLoop", () => {
  it("starts idempotently, records a cloned scan snapshot, and stops cleanly", async () => {
    const result = {
      status: "completed" as const,
      runId: "scan-1",
      scannedSourceCount: 3,
      createdCandidateCount: 1,
      duplicateCandidateCount: 1,
      expiredCandidateCount: 0,
      skippedCandidateCount: 1,
    };
    const scanner = { scan: vi.fn(async () => result) };
    let wake: (() => void) | undefined;
    const sleep = vi.fn(() => new Promise<void>((resolve) => { wake = resolve; }));
    const times = [
      new Date("2026-07-18T12:00:00.000Z"),
      new Date("2026-07-18T12:00:01.000Z"),
    ];
    const loop = createProactiveSignalWorkerLoop({
      scanner,
      intervalMs: 1000,
      now: () => times.shift() ?? new Date("2026-07-18T12:00:01.000Z"),
      sleep: async (_milliseconds, signal) => {
        await Promise.race([
          sleep(),
          new Promise<void>((_resolve, reject) => {
            signal.addEventListener("abort", () => {
              const error = new Error("aborted");
              error.name = "AbortError";
              reject(error);
            }, { once: true });
          }),
        ]);
      },
    });

    loop.start();
    loop.start();
    wake?.();
    await vi.waitFor(() => expect(scanner.scan).toHaveBeenCalledOnce());
    const snapshot = loop.getSnapshot();
    expect(snapshot).toMatchObject({
      running: true,
      intervalMs: 1000,
      latestScan: {
        status: "succeeded",
        result,
      },
    });
    await loop.stop();
    expect(loop.isRunning()).toBe(false);
    expect(snapshot.latestScan?.startedAt).not.toBe(loop.getSnapshot().latestScan?.startedAt);
  });

  it("isolates scanner and observer failures while recording a safe error", async () => {
    const scanner = { scan: vi.fn(async () => { throw new Error("database secret"); }) };
    const onError = vi.fn(() => { throw new Error("observer failed"); });
    let wake: (() => void) | undefined;
    const loop = createProactiveSignalWorkerLoop({
      scanner,
      intervalMs: 1000,
      onError,
      sleep: async (_milliseconds, signal) => new Promise<void>((resolve, reject) => {
        wake = resolve;
        signal.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        }, { once: true });
      }),
    });

    loop.start();
    wake?.();
    await vi.waitFor(() => expect(scanner.scan).toHaveBeenCalledOnce());
    expect(loop.getSnapshot().latestScan).toMatchObject({
      status: "failed",
      errorMessage: "proactive signal scan failed",
    });
    expect(onError).toHaveBeenCalledOnce();
    await loop.stop();
  });
});
