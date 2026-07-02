import { describe, expect, it, vi } from "vitest";

import { createEventWorkerRuntime } from "../src/runtime/event-worker-runtime.js";

describe("createEventWorkerRuntime", () => {
  it("returns undefined when the event worker is disabled", () => {
    expect(createEventWorkerRuntime({ env: {} })).toBeUndefined();
  });

  it("composes Redis queue, message repository, processor, worker, and loop when enabled", async () => {
    const pool = { query: vi.fn(), end: vi.fn(async () => undefined) };
    const redisClient = {
      connect: vi.fn(async () => redisClient),
      eval: vi.fn(async () => 1),
      rPush: vi.fn(async () => 1),
      lPop: vi.fn(async () => null),
      lLen: vi.fn().mockResolvedValueOnce(42).mockResolvedValueOnce(5),
      quit: vi.fn(async () => undefined),
    };
    const loop = {
      start: vi.fn(),
      stop: vi.fn(async () => undefined),
      isRunning: vi.fn(() => true),
      getSnapshot: vi.fn(() => ({
        running: true,
        intervalMs: 1000,
        batchLimit: 50,
        latestBatch: {
          status: "succeeded" as const,
          startedAt: new Date("2026-07-02T01:00:00.000Z"),
          finishedAt: new Date("2026-07-02T01:00:01.000Z"),
          processedCount: 2,
          failedCount: 1,
          failed: false as const,
        },
      })),
    };
    const messages = {
      upsertMessage: vi.fn(),
      listRecentByChat: vi.fn(),
    };
    const documentSources = {
      registerGroupVisibleDocument: vi.fn(),
    };
    const documentLinkExtractor = {
      extractLinks: vi.fn(() => []),
    };
    const documentSyncQueue = {
      enqueue: vi.fn(async () => undefined),
    };
    const documentSyncPlanner = {
      planRegisteredSources: vi.fn(async () => ({ enqueuedCount: 0, skippedCount: 0 })),
    };
    const groupVisibleDocumentRegistrar = {
      registerDiscoveredLinks: vi.fn(async () => undefined),
    };
    const processor = {
      process: vi.fn(async () => undefined),
    };
    const dependencies = {
      createPostgresPool: vi.fn(() => pool),
      createRedisClient: vi.fn(() => redisClient),
      createConversationMessageRepository: vi.fn(() => messages),
      createDocumentSourceRegistry: vi.fn(() => documentSources),
      createDocumentLinkExtractor: vi.fn(() => documentLinkExtractor),
      createDocumentSyncQueue: vi.fn(() => documentSyncQueue),
      createDiscoveredDocumentSyncPlanner: vi.fn(() => documentSyncPlanner),
      createGroupVisibleDocumentRegistrar: vi.fn(() => groupVisibleDocumentRegistrar),
      createProcessor: vi.fn(() => processor),
      createWorkerLoop: vi.fn(() => loop),
    };

    const runtime = createEventWorkerRuntime({
      env: enabledEnv(),
      dependencies,
    });

    expect(runtime).toBeDefined();
    expect(dependencies.createPostgresPool).toHaveBeenCalled();
    expect(dependencies.createConversationMessageRepository).toHaveBeenCalledWith({
      queryable: pool,
    });
    expect(dependencies.createDocumentSourceRegistry).toHaveBeenCalledWith(pool);
    expect(dependencies.createDocumentLinkExtractor).toHaveBeenCalledWith();
    expect(dependencies.createDocumentSyncQueue).toHaveBeenCalledWith();
    expect(dependencies.createDiscoveredDocumentSyncPlanner).toHaveBeenCalledWith({
      queue: documentSyncQueue,
    });
    expect(dependencies.createGroupVisibleDocumentRegistrar).toHaveBeenCalledWith({
      registry: documentSources,
      syncPlanner: documentSyncPlanner,
    });
    expect(dependencies.createProcessor).toHaveBeenCalledWith({
      messages,
      documentLinkExtractor,
      groupVisibleDocumentRegistrar,
    });
    runtime?.start();
    expect(loop.start).toHaveBeenCalledOnce();

    await expect(runtime?.getStatus()).resolves.toEqual({
      enabled: true,
      running: true,
      intervalMs: 1000,
      batchLimit: 50,
      pendingEventCount: 42,
      deadLetterEventCount: 5,
      latestBatch: {
        status: "succeeded",
        startedAt: new Date("2026-07-02T01:00:00.000Z"),
        finishedAt: new Date("2026-07-02T01:00:01.000Z"),
        processedCount: 2,
        failedCount: 1,
        failed: false,
      },
    });

    await runtime?.close();
    expect(loop.stop).toHaveBeenCalledOnce();
    expect(redisClient.quit).toHaveBeenCalledOnce();
    expect(pool.end).toHaveBeenCalledOnce();
  });
});

function enabledEnv() {
  return {
    IRIS_EVENT_WORKER_ENABLED: "true",
    REDIS_URL: "redis://localhost:6379",
    DATABASE_URL: "postgres://example",
  };
}
