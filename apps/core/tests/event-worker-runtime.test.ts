import { describe, expect, it, vi } from "vitest";

import { createEventWorkerRuntime } from "../src/runtime/event-worker-runtime.js";

describe("createEventWorkerRuntime", () => {
  it("returns undefined when the event worker is disabled", () => {
    expect(createEventWorkerRuntime({ env: {} })).toBeUndefined();
  });

  it("preflights partial mention reply config before opening resources", () => {
    const createPostgresPool = vi.fn(() => ({
      query: vi.fn(),
      end: vi.fn(async () => undefined),
    }));
    const redisClient = {
      connect: vi.fn(async () => redisClient),
      eval: vi.fn(async () => 1),
      rPush: vi.fn(async () => 1),
      lPop: vi.fn(async () => null),
      lLen: vi.fn(async () => 0),
      lRange: vi.fn(async () => []),
      lRem: vi.fn(async () => 0),
      sRem: vi.fn(),
      quit: vi.fn(async () => undefined),
    };
    const createRedisClient = vi.fn(() => redisClient);

    expect(() =>
      createEventWorkerRuntime({
        env: {
          ...enabledEnv(),
          IRIS_FEISHU_BOT_OPEN_ID: "ou_iris",
          FEISHU_APP_ID: "app-id",
        },
        dependencies: {
          createPostgresPool,
          createRedisClient,
        },
      }),
    ).toThrow("FEISHU_APP_SECRET is required");

    expect(createPostgresPool).not.toHaveBeenCalled();
    expect(createRedisClient).not.toHaveBeenCalled();
    expect(redisClient.connect).not.toHaveBeenCalled();
  });

  it("composes Redis queue, message repository, processor, worker, and loop when enabled", async () => {
    const pool = { query: vi.fn(), end: vi.fn(async () => undefined) };
    const redisClient = {
      connect: vi.fn(async () => redisClient),
      eval: vi.fn(async () => 1),
      rPush: vi.fn(async () => 1),
      lPop: vi.fn(async () => null),
      lLen: vi.fn().mockResolvedValueOnce(42).mockResolvedValueOnce(5),
      lRange: vi.fn(async () => []),
      lRem: vi.fn(async () => 0),
      sRem: vi.fn(),
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
    const memoryExtractionPlanner = {
      registerMessage: vi.fn(async () => undefined),
    };
    const runtimeController = {
      canProcessIncomingEvent: vi.fn(() => true),
      canReadGroupContext: vi.fn(() => true),
      canReadDocuments: vi.fn(() => true),
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
      runtimeController,
      memoryExtractionPlanner,
    });

    expect(runtime).toBeDefined();
    expect(dependencies.createPostgresPool).toHaveBeenCalled();
    expect(dependencies.createConversationMessageRepository).toHaveBeenCalledWith({
      queryable: pool,
    });
    expect(dependencies.createDocumentSourceRegistry).toHaveBeenCalledWith(pool);
    expect(dependencies.createDocumentLinkExtractor).toHaveBeenCalledWith();
    expect(dependencies.createDocumentSyncQueue).toHaveBeenCalledWith({
      eval: expect.any(Function),
      rPush: expect.any(Function),
      lPop: expect.any(Function),
      lLen: expect.any(Function),
      lRange: expect.any(Function),
      lRem: expect.any(Function),
      sRem: expect.any(Function),
    });
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
      runtimeController,
      memoryExtractionPlanner,
    });
    runtime?.start();
    expect(loop.start).toHaveBeenCalledOnce();

    await expect(runtime?.getStatus()).resolves.toEqual({
      enabled: true,
      running: true,
      intervalMs: 1000,
      batchLimit: 50,
      mentionRepliesEnabled: false,
      mentionRepliesUnavailableReason: "missing_bot_open_id",
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
    await expect(runtime?.deadLetters.list({ limit: 20 })).resolves.toEqual([]);
    expect(redisClient.lRange).toHaveBeenCalledWith("iris:events:raw:dlq", 0, 19);

    loop.stop.mockRejectedValueOnce(new Error("event loop stop failed"));
    await expect(runtime?.close()).rejects.toThrow("event loop stop failed");
    expect(loop.stop).toHaveBeenCalledOnce();
    expect(redisClient.quit).toHaveBeenCalledOnce();
    expect(pool.end).toHaveBeenCalledOnce();
  });

  it("composes mention answer replies when bot identity and answer drafting are configured", async () => {
    const pool = { query: vi.fn(), end: vi.fn(async () => undefined) };
    const redisClient = {
      connect: vi.fn(async () => redisClient),
      eval: vi.fn(async () => 1),
      rPush: vi.fn(async () => 1),
      lPop: vi.fn(async () => null),
      lLen: vi.fn(async () => 0),
      lRange: vi.fn(async () => []),
      lRem: vi.fn(async () => 0),
      sRem: vi.fn(),
      quit: vi.fn(async () => undefined),
    };
    const loop = {
      start: vi.fn(),
      stop: vi.fn(async () => undefined),
      isRunning: vi.fn(() => false),
      getSnapshot: vi.fn(() => ({
        running: false,
        intervalMs: 1000,
        batchLimit: 50,
      })),
    };
    const messages = {
      upsertMessage: vi.fn(),
      listRecentByChat: vi.fn(),
    };
    const tokenProvider = { getTenantAccessToken: vi.fn() };
    const replier = { replyText: vi.fn() };
    const mentionAnswerResponder = { maybeRespond: vi.fn() };
    const answerDraftOrchestrator = { generateDraft: vi.fn() };
    const runtimeController = {
      canProcessIncomingEvent: vi.fn(() => true),
      canReadGroupContext: vi.fn(() => true),
      canReadDocuments: vi.fn(() => true),
      canReplyWhenMentioned: vi.fn(() => true),
    };
    const dependencies = {
      createPostgresPool: vi.fn(() => pool),
      createRedisClient: vi.fn(() => redisClient),
      createConversationMessageRepository: vi.fn(() => messages),
      createDocumentSourceRegistry: vi.fn(() => ({ registerGroupVisibleDocument: vi.fn() })),
      createDocumentLinkExtractor: vi.fn(() => ({ extractLinks: vi.fn(() => []) })),
      createDocumentSyncQueue: vi.fn(() => ({ enqueue: vi.fn() })),
      createDiscoveredDocumentSyncPlanner: vi.fn(() => ({
        planRegisteredSources: vi.fn(async () => ({ enqueuedCount: 0, skippedCount: 0 })),
      })),
      createGroupVisibleDocumentRegistrar: vi.fn(() => ({
        registerDiscoveredLinks: vi.fn(),
      })),
      createFeishuTenantAccessTokenProvider: vi.fn(() => tokenProvider),
      createFeishuMessageReplier: vi.fn(() => replier),
      createMentionAnswerResponder: vi.fn(() => mentionAnswerResponder),
      createProcessor: vi.fn(() => ({ process: vi.fn() })),
      createWorkerLoop: vi.fn(() => loop),
    };

    const runtime = createEventWorkerRuntime({
      env: {
        ...enabledEnv(),
        FEISHU_APP_ID: "app-id",
        FEISHU_APP_SECRET: "app-secret",
        IRIS_FEISHU_BOT_OPEN_ID: "ou_iris",
      },
      dependencies,
      runtimeController,
      answerDraftOrchestrator,
    } as Parameters<typeof createEventWorkerRuntime>[0] & {
      answerDraftOrchestrator: typeof answerDraftOrchestrator;
    });

    expect(dependencies.createFeishuTenantAccessTokenProvider).toHaveBeenCalledWith({
      baseUrl: "https://open.feishu.cn",
      appId: "app-id",
      appSecret: "app-secret",
      timeoutMs: 10000,
    });
    expect(dependencies.createFeishuMessageReplier).toHaveBeenCalledWith({
      baseUrl: "https://open.feishu.cn",
      tokenProvider,
      timeoutMs: 10000,
    });
    expect(dependencies.createMentionAnswerResponder).toHaveBeenCalledWith({
      botOpenId: "ou_iris",
      answerDraftOrchestrator,
      replier,
      canReplyWhenMentioned: expect.any(Function),
    });
    expect(dependencies.createProcessor).toHaveBeenCalledWith(
      expect.objectContaining({
        messages,
        mentionAnswerResponder,
        runtimeController,
      }),
    );
    await expect(runtime?.getStatus()).resolves.toMatchObject({
      enabled: true,
      mentionRepliesEnabled: true,
    });
    await expect(runtime?.getStatus()).resolves.not.toHaveProperty(
      "mentionRepliesUnavailableReason",
    );
    await runtime?.close();
  });

  it("does not compose mention replies and reports missing setup reasons", async () => {
    const pool = { query: vi.fn(), end: vi.fn(async () => undefined) };
    const redisClient = {
      connect: vi.fn(async () => redisClient),
      eval: vi.fn(async () => 1),
      rPush: vi.fn(async () => 1),
      lPop: vi.fn(async () => null),
      lLen: vi.fn(async () => 0),
      lRange: vi.fn(async () => []),
      lRem: vi.fn(async () => 0),
      sRem: vi.fn(),
      quit: vi.fn(async () => undefined),
    };
    const dependencies = {
      createPostgresPool: vi.fn(() => pool),
      createRedisClient: vi.fn(() => redisClient),
      createConversationMessageRepository: vi.fn(() => ({
        upsertMessage: vi.fn(),
        listRecentByChat: vi.fn(),
      })),
      createDocumentSourceRegistry: vi.fn(() => ({ registerGroupVisibleDocument: vi.fn() })),
      createDocumentLinkExtractor: vi.fn(() => ({ extractLinks: vi.fn(() => []) })),
      createDocumentSyncQueue: vi.fn(() => ({ enqueue: vi.fn() })),
      createDiscoveredDocumentSyncPlanner: vi.fn(() => ({
        planRegisteredSources: vi.fn(async () => ({ enqueuedCount: 0, skippedCount: 0 })),
      })),
      createGroupVisibleDocumentRegistrar: vi.fn(() => ({
        registerDiscoveredLinks: vi.fn(),
      })),
      createMentionAnswerResponder: vi.fn(),
      createProcessor: vi.fn(() => ({ process: vi.fn() })),
      createWorkerLoop: vi.fn(() => ({
        start: vi.fn(),
        stop: vi.fn(async () => undefined),
        isRunning: vi.fn(() => false),
        getSnapshot: vi.fn(() => ({ running: false, intervalMs: 1000, batchLimit: 50 })),
      })),
    };

    const runtime = createEventWorkerRuntime({
      env: {
        ...enabledEnv(),
        FEISHU_APP_ID: "app-id",
        FEISHU_APP_SECRET: "app-secret",
      },
      dependencies,
      answerDraftOrchestrator: { generateDraft: vi.fn() },
    } as Parameters<typeof createEventWorkerRuntime>[0] & {
      answerDraftOrchestrator: { generateDraft: ReturnType<typeof vi.fn> };
    });

    expect(dependencies.createMentionAnswerResponder).not.toHaveBeenCalled();
    expect(dependencies.createProcessor).toHaveBeenCalledWith(
      expect.not.objectContaining({ mentionAnswerResponder: expect.anything() }),
    );
    await expect(runtime?.getStatus()).resolves.toMatchObject({
      enabled: true,
      mentionRepliesEnabled: false,
      mentionRepliesUnavailableReason: "missing_bot_open_id",
    });
    await runtime?.close();

    const missingFeishuConfigRuntime = createEventWorkerRuntime({
      env: {
        ...enabledEnv(),
        IRIS_FEISHU_BOT_OPEN_ID: "ou_iris",
      },
      dependencies,
      answerDraftOrchestrator: { generateDraft: vi.fn() },
    } as Parameters<typeof createEventWorkerRuntime>[0] & {
      answerDraftOrchestrator: { generateDraft: ReturnType<typeof vi.fn> };
    });

    await expect(missingFeishuConfigRuntime?.getStatus()).resolves.toMatchObject({
      enabled: true,
      mentionRepliesEnabled: false,
      mentionRepliesUnavailableReason: "missing_feishu_openapi_config",
    });
    await missingFeishuConfigRuntime?.close();

    const missingAnswerDraftRuntime = createEventWorkerRuntime({
      env: {
        ...enabledEnv(),
        FEISHU_APP_ID: "app-id",
        FEISHU_APP_SECRET: "app-secret",
        IRIS_FEISHU_BOT_OPEN_ID: "ou_iris",
      },
      dependencies,
    });

    await expect(missingAnswerDraftRuntime?.getStatus()).resolves.toMatchObject({
      enabled: true,
      mentionRepliesEnabled: false,
      mentionRepliesUnavailableReason: "missing_answer_draft_orchestrator",
    });
    await missingAnswerDraftRuntime?.close();
  });
});

function enabledEnv() {
  return {
    IRIS_EVENT_WORKER_ENABLED: "true",
    REDIS_URL: "redis://localhost:6379",
    DATABASE_URL: "postgres://example",
  };
}
