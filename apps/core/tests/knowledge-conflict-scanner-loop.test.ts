import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createKnowledgeConflictScannerLoop,
} from "../src/knowledge-conflicts/knowledge-conflict-scanner-loop.js";
import type { KnowledgeConflictScannerBatchResult } from
  "../src/knowledge-conflicts/knowledge-conflict-scanner.js";

describe("KnowledgeConflictScannerLoop", () => {
  afterEach(() => vi.useRealTimers());

  it("surfaces startup failure with a content-free snapshot", async () => {
    const loop = createKnowledgeConflictScannerLoop({
      scanner: { async scanBatch() { throw new Error("raw denied document text and token"); } },
      intervalMs: 1_000,
      batchLimit: 5,
      now: fixedClock(),
    });

    await expect(loop.start()).rejects.toThrow("knowledge conflict scanner startup failed");
    expect(loop.getSnapshot()).toMatchObject({
      running: false,
      latestBatch: { status: "failed", errorCode: "scanner_failed", failed: true },
    });
    expect(JSON.stringify(loop.getSnapshot())).not.toContain("denied document");
  });

  it("serializes scheduled batches and stop awaits the in-flight batch", async () => {
    vi.useFakeTimers();
    let resolveSecond: (() => void) | undefined;
    let calls = 0;
    const scanner = {
      async scanBatch() {
        calls += 1;
        if (calls === 2) {
          await new Promise<void>((resolve) => { resolveSecond = resolve; });
        }
        return batch({ claimed: calls, insufficientEvidence: calls });
      },
    };
    const loop = createKnowledgeConflictScannerLoop({
      scanner,
      intervalMs: 1_000,
      batchLimit: 5,
      now: fixedClock(),
    });

    await loop.start();
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls).toBe(2);

    let stopped = false;
    const stop = loop.stop().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    resolveSecond?.();
    await stop;
    expect(stopped).toBe(true);
  });

  it("keeps later failures safe, reports a stable observer error, and continues polling", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const onErrorMessages: string[] = [];
    const loop = createKnowledgeConflictScannerLoop({
      scanner: {
        async scanBatch() {
          calls += 1;
          if (calls === 2) throw new Error("raw provider response body");
          return batch({ claimed: 1, conflict: 1 });
        },
      },
      intervalMs: 1_000,
      batchLimit: 5,
      now: fixedClock(),
      onError(error) { onErrorMessages.push((error as Error).message); },
    });

    await loop.start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(loop.getSnapshot().latestBatch).toMatchObject({
      status: "failed", errorCode: "scanner_failed", failed: true,
    });
    expect(onErrorMessages).toEqual(["knowledge conflict scanner batch failed"]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls).toBe(3);
    expect(loop.getSnapshot().latestBatch).toMatchObject({
      status: "succeeded", conflict: 1, failed: false,
    });
    await loop.stop();
  });

  it("starts idempotently, returns cloned bounded snapshots, and cannot restart after close", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const loop = createKnowledgeConflictScannerLoop({
      scanner: {
        async scanBatch() {
          calls += 1;
          return batch({ discovered: 50, claimed: 50, insufficientEvidence: 50 });
        },
      },
      intervalMs: 1_000,
      batchLimit: 50,
      now: fixedClock(),
    });

    const firstStart = loop.start();
    const secondStart = loop.start();
    await Promise.all([firstStart, secondStart]);
    expect(calls).toBe(1);
    const snapshot = loop.getSnapshot();
    expect(snapshot).toMatchObject({
      running: true,
      intervalMs: 1_000,
      batchLimit: 50,
      latestBatch: { status: "succeeded", discovered: 50, claimed: 50 },
    });
    snapshot.latestBatch?.startedAt.setUTCFullYear(2030);
    expect(loop.getSnapshot().latestBatch?.startedAt.getUTCFullYear()).toBe(2026);

    await loop.stop();
    await loop.stop();
    await expect(loop.start()).rejects.toThrow("knowledge conflict scanner loop is closed");
  });
});

function batch(overrides: Partial<KnowledgeConflictScannerBatchResult> = {}): KnowledgeConflictScannerBatchResult {
  return {
    discovered: 0,
    claimed: 0,
    conflict: 0,
    noConflict: 0,
    insufficientEvidence: 0,
    permissionBlocked: 0,
    retrying: 0,
    deadLettered: 0,
    superseded: 0,
    ...overrides,
  };
}

function fixedClock(): () => Date {
  return () => new Date("2026-08-13T02:00:00.000Z");
}
