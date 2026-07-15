import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import type { EventWorkerRuntime } from "../src/runtime/event-worker-runtime.js";
import { installGracefulShutdown } from "../src/runtime/graceful-shutdown.js";
import type { MemoryExtractionRuntime } from "../src/runtime/memory-extraction-runtime.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("installGracefulShutdown", () => {
  it("closes application resources once on SIGTERM", async () => {
    const processTarget = new FakeProcessTarget();
    const close = vi.fn(async () => undefined);

    installGracefulShutdown({ close }, { processTarget });
    processTarget.emit("SIGTERM");
    processTarget.emit("SIGINT");
    await Promise.resolve();

    expect(close).toHaveBeenCalledOnce();
    expect(processTarget.exit).not.toHaveBeenCalled();
    expect(processTarget.listenerCount("SIGTERM")).toBe(0);
    expect(processTarget.listenerCount("SIGINT")).toBe(0);
  });

  it("gracefully closes the event runtime before its extraction dependency", async () => {
    const processTarget = new FakeProcessTarget();
    const closeOrder: string[] = [];
    const extractionRuntime = fakeMemoryExtractionRuntime({
      close: vi.fn(async () => {
        closeOrder.push("extraction");
      }),
    });
    const eventRuntime = fakeEventRuntime({
      close: vi.fn(async () => {
        closeOrder.push("event");
      }),
    });
    const app = buildApp({
      createAnswerDraftRuntime: () => undefined,
      createReindexWorkerRuntime: () => undefined,
      createMemoryExtractionRuntime: () => extractionRuntime,
      createEventWorkerRuntime: () => eventRuntime,
      createDocumentSyncRuntime: () => undefined,
    });

    installGracefulShutdown(app, { processTarget });
    processTarget.emit("SIGTERM");

    await vi.waitFor(() => expect(extractionRuntime.close).toHaveBeenCalledOnce());
    expect(closeOrder).toEqual(["event", "extraction"]);
    expect(eventRuntime.close).toHaveBeenCalledOnce();
    expect(processTarget.exit).not.toHaveBeenCalled();
  });

  it("forces exit before the Docker stop grace period when close stalls", async () => {
    vi.useFakeTimers();
    const processTarget = new FakeProcessTarget();
    const close = vi.fn(() => new Promise<void>(() => undefined));

    installGracefulShutdown(
      { close },
      { processTarget, timeoutMs: 25_000, reportError: vi.fn() },
    );
    processTarget.emit("SIGTERM");
    await vi.advanceTimersByTimeAsync(25_000);

    expect(close).toHaveBeenCalledOnce();
    expect(processTarget.exit).toHaveBeenCalledWith(1);
  });

  it("reports cleanup failure and exits non-zero", async () => {
    const processTarget = new FakeProcessTarget();
    const cleanupError = new Error("close failed");
    const reportError = vi.fn();

    installGracefulShutdown(
      { close: vi.fn(async () => Promise.reject(cleanupError)) },
      { processTarget, reportError },
    );
    processTarget.emit("SIGINT");
    await vi.waitFor(() => expect(processTarget.exit).toHaveBeenCalledWith(1));

    expect(reportError).toHaveBeenCalledWith("Iris graceful shutdown failed", cleanupError);
  });
});

class FakeProcessTarget extends EventEmitter {
  readonly exit = vi.fn((_code: number) => undefined);
}

function fakeEventRuntime(overrides: Partial<EventWorkerRuntime> = {}): EventWorkerRuntime {
  return {
    deadLetters: {
      list: vi.fn(async () => []),
      replay: vi.fn(async () => "not_found" as const),
      delete: vi.fn(async () => "not_found" as const),
      replayBatch: vi.fn(async () => ({
        replayedCount: 0,
        notFoundIds: [],
        unsupportedLegacyIds: [],
      })),
    },
    getStatus: vi.fn(async () => ({
      enabled: true as const,
      running: true,
      intervalMs: 1000,
      batchLimit: 50,
      mentionRepliesEnabled: false,
      pendingEventCount: 0,
      deadLetterEventCount: 0,
    })),
    start: vi.fn(),
    close: vi.fn(async () => undefined),
    ...overrides,
  };
}

function fakeMemoryExtractionRuntime(
  overrides: Partial<MemoryExtractionRuntime> = {},
): MemoryExtractionRuntime {
  return {
    planner: { registerMessage: vi.fn(async () => undefined) },
    deadLetters: {
      list: vi.fn(async () => []),
      replay: vi.fn(async () => "not_found" as const),
      delete: vi.fn(async () => "not_found" as const),
      replayBatch: vi.fn(async () => ({
        replayedCount: 0,
        notFoundIds: [],
        unsupportedLegacyIds: [],
      })),
    },
    getStatus: vi.fn(async () => ({
      enabled: true as const,
      running: true,
      workerHealthy: true,
      intervalMs: 1000,
      batchLimit: 20,
      minConfidence: 0.85,
      pendingJobCount: 0,
      processingJobCount: 0,
      delayedJobCount: 0,
      deadLetterJobCount: 0,
    })),
    start: vi.fn(),
    close: vi.fn(async () => undefined),
    ...overrides,
  };
}
