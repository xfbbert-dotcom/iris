import { describe, expect, expectTypeOf, it, vi } from "vitest";

import type { AnswerSourcePermissionVerifier } from "../src/answer-replies/answer-source-permission-verifier.js";
import type { FeishuMentionAnswerResponderDependencies } from "../src/conversation/feishu-mention-answer-responder.js";
import type { DocumentSource } from "../src/documents/document-source-registry.js";
import {
  createEventWorkerRuntime,
  type EventWorkerRuntimeDependencies,
  type EventWorkerRuntimeStatus,
} from "../src/runtime/event-worker-runtime.js";

expectTypeOf<EventWorkerRuntimeStatus["answerReplyUnresolvedCount"]>().toEqualTypeOf<number>();
expectTypeOf<EventWorkerRuntimeStatus["answerReplyPendingSafeNoticeCount"]>().toEqualTypeOf<number>();
expectTypeOf<
  EventWorkerRuntimeStatus["answerReplyReconciliationRequiredCount"]
>().toEqualTypeOf<number>();

describe("createEventWorkerRuntime", () => {
  it("returns undefined when the event worker is disabled", async () => {
    await expect(createEventWorkerRuntime({ env: {} })).resolves.toBeUndefined();
  });

  it("preflights partial mention reply config before opening resources", async () => {
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

    await expect(
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
    ).rejects.toThrow("FEISHU_APP_SECRET is required");

    expect(createPostgresPool).not.toHaveBeenCalled();
    expect(createRedisClient).not.toHaveBeenCalled();
    expect(redisClient.connect).not.toHaveBeenCalled();
  });

  it("composes Redis queue, message repository, processor, worker, and loop when enabled", async () => {
    const pool = { query: vi.fn(), end: vi.fn(async () => undefined) };
    const answerReplyRepository = fakeAnswerReplyRepository();
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
    const messageReplayGuard = {
      runUnlessDeleted: vi.fn(),
    };
    const documentSources = {
      registerGroupVisibleDocument: vi.fn(),
      registerUserSubmittedDocument: vi.fn(),
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
      createPostgresAnswerReplyRepository: vi.fn(() => answerReplyRepository),
      createRedisClient: vi.fn(() => redisClient),
      createConversationMessageRepository: vi.fn(() => messages),
      createMessageReplayGuard: vi.fn(() => messageReplayGuard),
      createDocumentSourceRegistry: vi.fn(() => documentSources),
      createDocumentLinkExtractor: vi.fn(() => documentLinkExtractor),
      createDocumentSyncQueue: vi.fn(() => documentSyncQueue),
      createDiscoveredDocumentSyncPlanner: vi.fn(() => documentSyncPlanner),
      createGroupVisibleDocumentRegistrar: vi.fn(() => groupVisibleDocumentRegistrar),
      createProcessor: vi.fn(() => processor),
      createWorkerLoop: vi.fn(() => loop),
    };

    const runtime = await createEventWorkerRuntime({
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
    expect(dependencies.createMessageReplayGuard).toHaveBeenCalledWith({ dataSource: pool });
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
      messageReplayGuard,
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
      answerReplyUnresolvedCount: 2,
      answerReplyPendingSafeNoticeCount: 1,
      answerReplyReconciliationRequiredCount: 1,
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
    const compositionOrder: string[] = [];
    const pool = { query: vi.fn(), end: vi.fn(async () => undefined) };
    const answerReplyRepository = fakeAnswerReplyRepository();
    const answerReplyDeliveryService = { respond: vi.fn() };
    let deliveryServiceVerifier: AnswerSourcePermissionVerifier | undefined;
    const now = () => new Date("2026-08-02T06:07:08.000Z");
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
    const knowledgeDraftCommand = { execute: vi.fn() };
    const registeredUserSubmittedSource: DocumentSource = {
      id: "user-source-1",
      sourceType: "user_submitted_document",
      sourceUri: "https://docs.feishu.cn/docx/user_doc_token_1",
      submittedByUserId: "ou_alice",
      permissionState: "unknown",
      syncState: "pending",
      canUseForAnswering: true,
      canUseForKnowledgeDrafts: false,
      createdAt: new Date("2026-07-24T02:30:00.000Z"),
      updatedAt: new Date("2026-07-24T02:30:00.000Z"),
      evidence: [],
    };
    const documentSources = {
      registerGroupVisibleDocument: vi.fn(),
      registerUserSubmittedDocument: vi.fn(async () => registeredUserSubmittedSource),
    };
    const documentSyncPlanner = {
      planRegisteredSources: vi.fn(async () => ({ enqueuedCount: 1, skippedCount: 0 })),
    };
    const runtimeController = {
      canProcessIncomingEvent: vi.fn(() => true),
      canReadGroupContext: vi.fn(() => true),
      canReadDocuments: vi.fn(() => true),
      canReplyWhenMentioned: vi.fn(() => true),
    };
    const dependencies = {
      createPostgresPool: vi.fn(() => {
        compositionOrder.push("pool");
        return pool;
      }),
      createPostgresAnswerReplyRepository: vi.fn(() => answerReplyRepository),
      createAnswerReplyDeliveryService: vi.fn(
        (input: { verifier: AnswerSourcePermissionVerifier }) => {
          deliveryServiceVerifier = input.verifier;
          return answerReplyDeliveryService;
        },
      ),
      createRedisClient: vi.fn(() => redisClient),
      createConversationMessageRepository: vi.fn(() => messages),
      createDocumentSourceRegistry: vi.fn(() => documentSources),
      createDocumentLinkExtractor: vi.fn(() => ({ extractLinks: vi.fn(() => []) })),
      createDocumentSyncQueue: vi.fn(() => ({ enqueue: vi.fn() })),
      createDiscoveredDocumentSyncPlanner: vi.fn(() => documentSyncPlanner),
      createGroupVisibleDocumentRegistrar: vi.fn(() => ({
        registerDiscoveredLinks: vi.fn(),
      })),
      createFeishuTenantAccessTokenProvider: vi.fn(() => tokenProvider),
      createFeishuMessageReplier: vi.fn(() => replier),
      createMentionAnswerResponder: vi.fn(
        (input: FeishuMentionAnswerResponderDependencies) => {
          compositionOrder.push("responder");
          mentionResponderInput = input;
          return mentionAnswerResponder;
        },
      ),
      createProcessor: vi.fn(() => ({ process: vi.fn() })),
      createWorkerLoop: vi.fn(() => loop),
    };

    let mentionResponderInput: FeishuMentionAnswerResponderDependencies | undefined;
    const runtime = await createEventWorkerRuntime({
      env: {
        ...enabledEnv(),
        FEISHU_APP_ID: "app-id",
        FEISHU_APP_SECRET: "app-secret",
        IRIS_FEISHU_BOT_OPEN_ID: "ou_iris",
      },
      dependencies,
      runtimeController,
      answerDraftOrchestrator,
      knowledgeDraftCommand,
      now,
    } as Parameters<typeof createEventWorkerRuntime>[0] & {
      answerDraftOrchestrator: typeof answerDraftOrchestrator;
      knowledgeDraftCommand: typeof knowledgeDraftCommand;
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
    expect(compositionOrder).toEqual(["pool", "responder"]);
    expect(dependencies.createPostgresAnswerReplyRepository).toHaveBeenCalledOnce();
    expect(dependencies.createPostgresAnswerReplyRepository).toHaveBeenCalledWith({
      dataSource: pool,
    });
    expect(dependencies.createAnswerReplyDeliveryService).toHaveBeenCalledOnce();
    expect(dependencies.createAnswerReplyDeliveryService).toHaveBeenCalledWith({
      repository: answerReplyRepository,
      replier,
      verifier: expect.any(Object),
      now,
    });
    await expect(deliveryServiceVerifier?.verify({
      chatId: "oc_pilot",
      documentSourceIds: ["source-1"],
    })).resolves.toEqual([{ documentSourceId: "source-1", outcome: "error" }]);
    expect(dependencies.createMentionAnswerResponder).toHaveBeenCalledWith({
      botOpenId: "ou_iris",
      answerDraftOrchestrator,
      answerReplyDeliveryService,
      knowledgeDraftCommand,
      replier,
      now,
      canReplyWhenMentioned: expect.any(Function),
      canRegisterUserSubmittedDocuments: expect.any(Function),
      documentLinkExtractor: expect.any(Object),
      userSubmittedDocumentRegistrar: expect.objectContaining({
        registerUserSubmittedDocument: expect.any(Function),
      }),
    });
    expect(mentionResponderInput?.userSubmittedDocumentRegistrar).toBeDefined();
    await expect(
      mentionResponderInput?.userSubmittedDocumentRegistrar?.registerUserSubmittedDocument({
        sourceUri: "https://docs.feishu.cn/docx/user_doc_token_1",
        submittedByUserId: "ou_alice",
        observedAt: new Date("2026-07-24T02:30:00.000Z"),
      }),
    ).resolves.toBe(registeredUserSubmittedSource);
    expect(documentSources.registerUserSubmittedDocument).toHaveBeenCalledWith({
      sourceUri: "https://docs.feishu.cn/docx/user_doc_token_1",
      submittedByUserId: "ou_alice",
      observedAt: new Date("2026-07-24T02:30:00.000Z"),
    });
    expect(documentSyncPlanner.planRegisteredSources).toHaveBeenCalledWith([
      registeredUserSubmittedSource,
    ]);
    expect(dependencies.createProcessor).toHaveBeenCalledWith(
      expect.objectContaining({
        messages,
        mentionAnswerResponder,
        runtimeController,
      }),
    );
    expect(runtime?.answerReplies).toBeDefined();
    expect(Object.keys(runtime?.answerReplies ?? {})).toEqual(["findByIncomingMessage"]);
    expect(runtime?.answerReplies).not.toHaveProperty("prepare");
    const status = await runtime?.getStatus();
    expect(status).toMatchObject({
      enabled: true,
      mentionRepliesEnabled: true,
      answerReplyUnresolvedCount: 2,
      answerReplyPendingSafeNoticeCount: 1,
      answerReplyReconciliationRequiredCount: 1,
    });
    expect(status).not.toHaveProperty("mentionRepliesUnavailableReason");
    answerReplyRepository.getStatus.mockRejectedValueOnce(new Error("answer status unavailable"));
    await expect(runtime?.getStatus()).rejects.toThrow("answer status unavailable");
    await runtime?.close();
    expect(pool.end).toHaveBeenCalledOnce();
  });

  it("awaits both acquired-resource cleanups before rejecting an early composition failure", async () => {
    const redisCleanup = createDeferred<void>();
    const poolCleanup = createDeferred<void>();
    const fixture = createConstructionFailureFixture({ redisCleanup, poolCleanup });
    const compositionError = new Error("answer repository composition failed");
    fixture.dependencies.createPostgresAnswerReplyRepository = vi.fn(() => {
      throw compositionError;
    });
    let settled = false;

    const construction = createEventWorkerRuntime({
      env: enabledEnv(),
      dependencies: fixture.dependencies,
    });
    void construction.then(
      () => { settled = true; },
      () => { settled = true; },
    );

    await Promise.resolve();
    expect(fixture.redisClient.quit).toHaveBeenCalledOnce();
    expect(fixture.pool.end).toHaveBeenCalledOnce();
    expect(settled).toBe(false);

    redisCleanup.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);

    poolCleanup.resolve();
    await expect(construction).rejects.toBe(compositionError);
  });

  it("preserves a late composition error after both acquired-resource cleanups reject", async () => {
    const redisCleanup = createDeferred<void>();
    const poolCleanup = createDeferred<void>();
    const fixture = createConstructionFailureFixture({ redisCleanup, poolCleanup });
    const compositionError = new Error("worker loop composition failed");
    fixture.dependencies.createWorkerLoop = vi.fn(() => {
      throw compositionError;
    });
    let settled = false;

    const construction = createEventWorkerRuntime({
      env: enabledEnv(),
      dependencies: fixture.dependencies,
    });
    void construction.then(
      () => { settled = true; },
      () => { settled = true; },
    );

    await Promise.resolve();
    expect(fixture.redisClient.quit).toHaveBeenCalledOnce();
    expect(fixture.pool.end).toHaveBeenCalledOnce();
    expect(settled).toBe(false);

    redisCleanup.reject(new Error("Redis cleanup failed"));
    await Promise.resolve();
    expect(settled).toBe(false);

    poolCleanup.reject(new Error("pool cleanup failed"));
    await expect(construction).rejects.toBe(compositionError);
  });

  it("awaits pool-only cleanup when Redis acquisition fails", async () => {
    const poolCleanup = createDeferred<void>();
    const pool = {
      query: vi.fn(),
      end: vi.fn(() => poolCleanup.promise),
    };
    const redisAcquisitionError = new Error("Redis client composition failed");
    const createRedisClient = vi.fn(() => {
      throw redisAcquisitionError;
    });
    let settled = false;

    const construction = createEventWorkerRuntime({
      env: enabledEnv(),
      dependencies: {
        createPostgresPool: vi.fn(() => pool),
        createRedisClient,
      },
    });
    void construction.then(
      () => { settled = true; },
      () => { settled = true; },
    );

    await Promise.resolve();
    expect(createRedisClient).toHaveBeenCalledOnce();
    expect(pool.end).toHaveBeenCalledOnce();
    expect(settled).toBe(false);

    poolCleanup.reject(new Error("pool cleanup failed"));
    await expect(construction).rejects.toBe(redisAcquisitionError);
  });

  it("does not compose mention replies and reports missing setup reasons", async () => {
    const pool = { query: vi.fn(), end: vi.fn(async () => undefined) };
    const answerReplyRepository = fakeAnswerReplyRepository();
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
      createPostgresAnswerReplyRepository: vi.fn(() => answerReplyRepository),
      createRedisClient: vi.fn(() => redisClient),
      createConversationMessageRepository: vi.fn(() => ({
        upsertMessage: vi.fn(),
        listRecentByChat: vi.fn(),
      })),
      createDocumentSourceRegistry: vi.fn(() => ({
        registerGroupVisibleDocument: vi.fn(),
        registerUserSubmittedDocument: vi.fn(),
      })),
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

    const runtime = await createEventWorkerRuntime({
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

    const missingFeishuConfigRuntime = await createEventWorkerRuntime({
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

    const missingAnswerDraftRuntime = await createEventWorkerRuntime({
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

function fakeAnswerReplyRepository() {
  return {
    findByIncomingMessage: vi.fn(async () => undefined),
    prepare: vi.fn(),
    beginAnswerSend: vi.fn(),
    completeAnswerSend: vi.fn(),
    blockForPermission: vi.fn(),
    beginSafeNoticeSend: vi.fn(),
    completeSafeNoticeSend: vi.fn(),
    getStatus: vi.fn(async () => ({
      unresolvedCount: 2,
      pendingSafeNoticeCount: 1,
      reconciliationRequiredCount: 1,
    })),
  };
}

function createConstructionFailureFixture({
  redisCleanup,
  poolCleanup,
}: {
  redisCleanup?: Deferred<void>;
  poolCleanup?: Deferred<void>;
} = {}) {
  const pool = {
    query: vi.fn(),
    end: vi.fn(() => poolCleanup?.promise ?? Promise.resolve()),
  };
  const redisClient = {
    connect: vi.fn(async () => redisClient),
    eval: vi.fn(async () => 1),
    rPush: vi.fn(async () => 1),
    lPop: vi.fn(async () => null),
    lLen: vi.fn(async () => 0),
    lRange: vi.fn(async () => []),
    lRem: vi.fn(async () => 0),
    sRem: vi.fn(async () => 0),
    quit: vi.fn(() => redisCleanup?.promise ?? Promise.resolve()),
  };
  const dependencies: EventWorkerRuntimeDependencies = {
    createPostgresPool: vi.fn(() => pool),
    createRedisClient: vi.fn(() => redisClient),
    createPostgresAnswerReplyRepository: vi.fn(() => fakeAnswerReplyRepository()),
    createConversationMessageRepository: vi.fn(() => ({
      upsertMessage: vi.fn(),
      listRecentByChat: vi.fn(),
    })),
    createMessageReplayGuard: vi.fn(() => ({ runUnlessDeleted: vi.fn() })),
    createDocumentSourceRegistry: vi.fn(() => ({
      registerGroupVisibleDocument: vi.fn(),
      registerUserSubmittedDocument: vi.fn(),
    })),
    createDocumentLinkExtractor: vi.fn(() => ({ extractLinks: vi.fn(() => []) })),
    createDocumentSyncQueue: vi.fn(() => ({ enqueue: vi.fn() })),
    createDiscoveredDocumentSyncPlanner: vi.fn(() => ({
      planRegisteredSources: vi.fn(async () => ({ enqueuedCount: 0, skippedCount: 0 })),
    })),
    createGroupVisibleDocumentRegistrar: vi.fn(() => ({
      registerDiscoveredLinks: vi.fn(),
    })),
    createProcessor: vi.fn(() => ({ process: vi.fn() })),
    createWorkerLoop: vi.fn(() => ({
      start: vi.fn(),
      stop: vi.fn(async () => undefined),
      isRunning: vi.fn(() => false),
      getSnapshot: vi.fn(() => ({ running: false, intervalMs: 1000, batchLimit: 50 })),
    })),
  };

  return { dependencies, pool, redisClient };
}

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
};

function createDeferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
