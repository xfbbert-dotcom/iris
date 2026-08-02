import { describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import type { EventWorkerRuntime } from "../src/runtime/event-worker-runtime.js";
import type { KnowledgeCardRuntime } from "../src/runtime/knowledge-card-runtime.js";
import { closeRuntimeResources } from "../src/runtime/runtime-close.js";

describe("runtime cleanup", () => {
  it("preserves one shared-helper cleanup error identity while attempting later steps", async () => {
    const order: string[] = [];
    const cleanupError = new Error("single cleanup failed");

    await expect(closeRuntimeResources([
      async () => {
        order.push("first");
        throw cleanupError;
      },
      async () => {
        order.push("second");
      },
    ])).rejects.toBe(cleanupError);
    expect(order).toEqual(["first", "second"]);
  });

  it("rethrows one cleanup failure without wrapping it", async () => {
    const eventCloseError = new Error("event worker cleanup failed");
    const eventWorkerRuntime = fakeEventWorkerRuntime({
      close: vi.fn(async () => {
        throw eventCloseError;
      }),
    });
    const app = await buildApp({
      createAnswerDraftRuntime: () => undefined,
      createEventWorkerRuntime: () => eventWorkerRuntime,
      createDocumentSyncRuntime: () => undefined,
      createReindexWorkerRuntime: () => undefined,
    });

    await expect(app.close()).rejects.toBe(eventCloseError);
    expect(eventWorkerRuntime.close).toHaveBeenCalledOnce();
  });

  it("closes every resource and preserves all failures in operation order", async () => {
    const closeOrder: string[] = [];
    const eventCloseError = new Error("event worker cleanup failed");
    const knowledgeCardCloseError = new Error("knowledge card cleanup failed");
    const runtimeCloseError = new Error("runtime-control pool cleanup failed");
    const eventWorkerRuntime = fakeEventWorkerRuntime({
      close: vi.fn(async () => {
        closeOrder.push("event");
        throw eventCloseError;
      }),
    });
    const closeRuntimeControl = vi.fn(async () => {
      closeOrder.push("runtime-control");
      throw runtimeCloseError;
    });
    const knowledgeCardRuntime = fakeKnowledgeCardRuntime({
      close: vi.fn(async () => {
        closeOrder.push("knowledge-cards");
        throw knowledgeCardCloseError;
      }),
    });
    const app = await buildApp({
      createAnswerDraftRuntime: () => undefined,
      createEventWorkerRuntime: () => eventWorkerRuntime,
      createDocumentSyncRuntime: () => undefined,
      createReindexWorkerRuntime: () => undefined,
      createKnowledgeCardRuntime: () => knowledgeCardRuntime,
      closeRuntimeControl,
    });

    let cleanupError: unknown;
    try {
      await app.close();
    } catch (error) {
      cleanupError = error;
    }

    expect(cleanupError).toBeInstanceOf(AggregateError);
    expect((cleanupError as AggregateError).message).toBe(
      "Iris runtime resource cleanup failed",
    );
    expect((cleanupError as AggregateError).errors).toEqual([
      eventCloseError,
      knowledgeCardCloseError,
      runtimeCloseError,
    ]);
    expect(closeOrder).toEqual(["event", "knowledge-cards", "runtime-control"]);
    expect(eventWorkerRuntime.close).toHaveBeenCalledOnce();
    expect(knowledgeCardRuntime.close).toHaveBeenCalledOnce();
    expect(closeRuntimeControl).toHaveBeenCalledOnce();
  });

  it("rethrows one aggregate cleanup failure without replacing it", async () => {
    const firstEventCloseError = new Error("event queue cleanup failed");
    const secondEventCloseError = new Error("event database cleanup failed");
    const eventCloseError = new AggregateError(
      [firstEventCloseError, secondEventCloseError],
      "event worker cleanup failed",
    );
    const eventWorkerRuntime = fakeEventWorkerRuntime({
      close: vi.fn(async () => {
        throw eventCloseError;
      }),
    });
    const app = await buildApp({
      createAnswerDraftRuntime: () => undefined,
      createEventWorkerRuntime: () => eventWorkerRuntime,
      createDocumentSyncRuntime: () => undefined,
      createReindexWorkerRuntime: () => undefined,
    });

    await expect(app.close()).rejects.toBe(eventCloseError);
  });
});

function fakeEventWorkerRuntime(
  overrides: Partial<EventWorkerRuntime> = {},
): EventWorkerRuntime {
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
      intervalMs: 100,
      batchLimit: 10,
      mentionRepliesEnabled: false,
      pendingEventCount: 0,
      deadLetterEventCount: 0,
    })),
    start: vi.fn(),
    close: vi.fn(async () => undefined),
    ...overrides,
  };
}

function fakeKnowledgeCardRuntime(
  overrides: Partial<KnowledgeCardRuntime> = {},
): KnowledgeCardRuntime {
  return {
    gateway: { handleCallback: vi.fn() },
    repository: {} as KnowledgeCardRuntime["repository"],
    deadLetters: {
      list: vi.fn(async () => []),
      replay: vi.fn(async () => "not_found" as const),
      delete: vi.fn(async () => "not_found" as const),
    },
    canUseKnowledgeCards: vi.fn(() => true),
    approvalInteractions: {} as KnowledgeCardRuntime["approvalInteractions"],
    bindActionApprovalWorker: vi.fn(),
    start: vi.fn(),
    getStatus: vi.fn(),
    close: vi.fn(async () => undefined),
    ...overrides,
  };
}
