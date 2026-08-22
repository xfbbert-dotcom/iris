import { describe, expect, it, vi } from "vitest";

import { createFeishuTaskExecutionLoop } from
  "../src/formal-tasks/feishu-task-execution-loop.js";

describe("FeishuTaskExecutionLoop", () => {
  it("runs execution, reconciliation, and result delivery in isolation", async () => {
    const fixture = createFixture();
    fixture.loop.start();
    await fixture.runTick();

    expect(fixture.executor.processBatch).toHaveBeenCalledWith({ limit: 10 });
    expect(fixture.reconciler.processBatch).toHaveBeenCalledWith({ limit: 10 });
    expect(fixture.resultDispatcher.processBatch).toHaveBeenCalledWith({ limit: 10 });
    expect(fixture.loop.getSnapshot()).toMatchObject({
      running: true,
      intervalMs: 5_000,
      batchLimit: 10,
      latestBatch: {
        status: "succeeded",
        executionCount: 1,
        reconciliationCount: 1,
        resultDeliveryCount: 1,
        failed: false,
      },
    });
    await fixture.loop.stop();
  });

  it("continues later stages and reports partial failure when execution fails", async () => {
    const fixture = createFixture({ executorError: new Error("private execution detail") });
    fixture.loop.start();
    await fixture.runTick();

    expect(fixture.reconciler.processBatch).toHaveBeenCalledOnce();
    expect(fixture.resultDispatcher.processBatch).toHaveBeenCalledOnce();
    expect(fixture.onError).toHaveBeenCalledOnce();
    expect(fixture.loop.getSnapshot().latestBatch).toMatchObject({
      status: "partial_failed",
      executorFailed: true,
      reconcilerFailed: false,
      resultDispatcherFailed: false,
      errorCode: "formal_task_worker_failed",
    });
    await fixture.loop.stop();
  });

  it("reports failed only when all three isolated stages fail", async () => {
    const fixture = createFixture({
      executorError: new Error("executor"),
      reconcilerError: new Error("reconciler"),
      resultError: new Error("result"),
    });
    fixture.loop.start();
    await fixture.runTick();
    expect(fixture.loop.getSnapshot().latestBatch).toMatchObject({
      status: "failed",
      executorFailed: true,
      reconcilerFailed: true,
      resultDispatcherFailed: true,
      failed: true,
    });
    await fixture.loop.stop();
  });

  it("validates timer and batch bounds", () => {
    expect(() => createFixture({ intervalMs: 0 })).toThrow(/intervalMs/iu);
    expect(() => createFixture({ batchLimit: 101 })).toThrow(/batchLimit/iu);
  });
});

function createFixture(overrides: {
  executorError?: Error;
  reconcilerError?: Error;
  resultError?: Error;
  intervalMs?: number;
  batchLimit?: number;
} = {}) {
  const executor = {
    processBatch: overrides.executorError === undefined
      ? vi.fn(async () => [{ status: "created" }])
      : vi.fn(async () => { throw overrides.executorError; }),
  };
  const reconciler = {
    processBatch: overrides.reconcilerError === undefined
      ? vi.fn(async () => [{ status: "reconciled" }])
      : vi.fn(async () => { throw overrides.reconcilerError; }),
  };
  const resultDispatcher = {
    processBatch: overrides.resultError === undefined
      ? vi.fn(async () => [{ status: "sent" }])
      : vi.fn(async () => { throw overrides.resultError; }),
  };
  const scheduled: Array<() => void> = [];
  const setTimeout = vi.fn((callback: () => void) => {
    scheduled.push(callback);
    return 1 as unknown as ReturnType<typeof globalThis.setTimeout>;
  });
  const clearTimeout = vi.fn();
  const onError = vi.fn();
  let tick = 0;
  const loop = createFeishuTaskExecutionLoop({
    executor: executor as never,
    reconciler: reconciler as never,
    resultDispatcher: resultDispatcher as never,
    intervalMs: overrides.intervalMs ?? 5_000,
    batchLimit: overrides.batchLimit ?? 10,
    onError,
    now: () => new Date(1_000 + tick++ * 1_000),
    setTimeout: setTimeout as never,
    clearTimeout: clearTimeout as never,
  });
  return {
    loop,
    executor,
    reconciler,
    resultDispatcher,
    onError,
    async runTick() {
      const callback = scheduled.shift();
      if (callback === undefined) throw new Error("tick was not scheduled");
      callback();
      await vi.waitFor(() => {
        expect(loop.getSnapshot().latestBatch).toBeDefined();
      });
    },
  };
}
