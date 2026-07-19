import { describe, expect, it, vi } from "vitest";

import { createDocumentSyncRuntime } from "../src/runtime/document-sync-runtime.js";
import { createEventWorkerRuntime } from "../src/runtime/event-worker-runtime.js";
import { createReindexWorkerRuntime } from "../src/runtime/reindex-worker-runtime.js";
import {
  createKnowledgeCardRuntime,
  type KnowledgeCardRuntimeDependencies,
} from "../src/runtime/knowledge-card-runtime.js";
import { RuntimeController } from "../src/admin/runtime-controller.js";
import { createDefaultRuntimeConfig } from "../src/config/runtime-config.js";

describe("runtime startup promises", () => {
  it("does not emit an unhandled rejection when event worker Redis connect fails before use", async () => {
    const runtime = await expectNoUnhandledRejectionDuringStartup(() =>
      createEventWorkerRuntime({
        env: eventWorkerEnv(),
        dependencies: eventWorkerDependencies({
          connect: vi.fn(async () => {
            throw new Error("redis unavailable");
          }),
        }),
      }),
    );

    await expect(runtime?.getStatus()).rejects.toThrow("redis unavailable");
    await expect(runtime?.close()).rejects.toThrow("redis unavailable");
  });

  it("does not emit an unhandled rejection when document sync Redis connect fails before use", async () => {
    const runtime = await expectNoUnhandledRejectionDuringStartup(() =>
      createDocumentSyncRuntime({
        env: documentSyncEnv(),
        dependencies: documentSyncDependencies({
          connect: vi.fn(async () => {
            throw new Error("redis unavailable");
          }),
        }),
      }),
    );

    await expect(runtime?.getStatus()).resolves.toMatchObject({ enabled: true });
    await expect(runtime?.close()).rejects.toThrow("redis unavailable");
  });

  it("does not emit an unhandled rejection when reindex Redis connect fails before use", async () => {
    const runtime = await expectNoUnhandledRejectionDuringStartup(() =>
      createReindexWorkerRuntime({
        env: reindexWorkerEnv(),
        dependencies: reindexWorkerDependencies({
          redisConnect: vi.fn(async () => {
            throw new Error("redis unavailable");
          }),
        }),
      }),
    );

    await expect(runtime?.getStatus()).rejects.toThrow("redis unavailable");
    await expect(runtime?.close()).rejects.toThrow("redis unavailable");
  });

  it("does not emit an unhandled rejection when reindex profile initialization fails before use", async () => {
    const runtime = await expectNoUnhandledRejectionDuringStartup(() =>
      createReindexWorkerRuntime({
        env: reindexWorkerEnv(),
        dependencies: reindexWorkerDependencies({
          findOrCreateProfile: vi.fn(async () => {
            throw new Error("profile store unavailable");
          }),
        }),
      }),
    );

    await expect(
      runtime?.planner.planDocumentProfileReindex({
        embeddingProfileId: "openai-compatible:text-embedding-small:1536",
        limit: 10,
      }),
    ).rejects.toThrow("profile store unavailable");
    await runtime?.close();
  });

  it("observes knowledge-card Redis startup failure and still closes Postgres", async () => {
    const dependencies = knowledgeCardDependencies({
      connect: vi.fn(async () => {
        throw new Error("knowledge card redis unavailable");
      }),
    });
    const runtime = await expectNoUnhandledRejectionDuringStartup(() =>
      createKnowledgeCardRuntime({
        env: knowledgeCardEnv(),
        runtimeController: new RuntimeController(createDefaultRuntimeConfig()),
        dependencies,
      }),
    );

    await expect(runtime?.getStatus()).rejects.toThrow("knowledge card redis unavailable");
    await expect(runtime?.close()).rejects.toThrow("knowledge card redis unavailable");
    expect(dependencies.redis.quit).toHaveBeenCalledOnce();
    expect(dependencies.pool.end).toHaveBeenCalledOnce();
  });
});

async function expectNoUnhandledRejectionDuringStartup<T>(createRuntime: () => T): Promise<T> {
  const unhandledRejections: unknown[] = [];
  const onUnhandledRejection = (reason: unknown) => {
    unhandledRejections.push(reason);
  };

  process.on("unhandledRejection", onUnhandledRejection);
  try {
    const runtime = createRuntime();
    await new Promise((resolve) => setImmediate(resolve));
    expect(unhandledRejections).toEqual([]);
    return runtime;
  } finally {
    process.off("unhandledRejection", onUnhandledRejection);
  }
}

function eventWorkerEnv() {
  return {
    IRIS_EVENT_WORKER_ENABLED: "true",
    REDIS_URL: "redis://localhost:6379",
    DATABASE_URL: "postgres://example",
  };
}

function documentSyncEnv() {
  return {
    IRIS_DOCUMENT_SYNC_WORKER_ENABLED: "true",
    DATABASE_URL: "postgres://example",
    REDIS_URL: "redis://localhost:6379",
    FEISHU_APP_ID: "app-id",
    FEISHU_APP_SECRET: "app-secret",
    FEISHU_OPEN_BASE_URL: "https://open.example.com/",
  };
}

function reindexWorkerEnv() {
  return {
    IRIS_REINDEX_WORKER_ENABLED: "true",
    DATABASE_URL: "postgres://example",
    REDIS_URL: "redis://localhost:6379",
    IRIS_EMBEDDING_PROVIDER: "openai-compatible",
    IRIS_EMBEDDING_BASE_URL: "https://api.example.com/v1",
    IRIS_EMBEDDING_API_KEY: "key",
    IRIS_EMBEDDING_MODEL: "text-embedding-small",
    IRIS_EMBEDDING_DIMENSIONS: "1536",
  };
}

function knowledgeCardEnv() {
  return {
    IRIS_KNOWLEDGE_CARD_ENABLED: "true",
    IRIS_KNOWLEDGE_CARD_GROUP_IDS: "oc_pilot",
    DATABASE_URL: "postgres://example",
    REDIS_URL: "redis://localhost:6379",
    FEISHU_VERIFICATION_TOKEN: "verification-token",
    FEISHU_APP_ID: "app-id",
    FEISHU_APP_SECRET: "app-secret",
    IRIS_FEISHU_BOT_OPEN_ID: "ou_irisbot",
  };
}

function eventWorkerDependencies({ connect }: { connect: ReturnType<typeof vi.fn> }) {
  const pool = { query: vi.fn(), end: vi.fn(async () => undefined) };
  const redisClient = redisClientFixture({ connect });

  return {
    createPostgresPool: vi.fn(() => pool),
    createRedisClient: vi.fn(() => redisClient),
    createConversationMessageRepository: vi.fn(() => ({
      upsertMessage: vi.fn(),
      listRecentByChat: vi.fn(),
    })),
    createDocumentSourceRegistry: vi.fn(() => ({ registerGroupVisibleDocument: vi.fn() })),
    createDocumentLinkExtractor: vi.fn(() => ({ extractLinks: vi.fn(() => []) })),
    createDocumentSyncQueue: vi.fn(() => ({
      enqueue: vi.fn(async () => undefined),
    })),
    createDiscoveredDocumentSyncPlanner: vi.fn(() => ({
      planRegisteredSources: vi.fn(async () => ({ enqueuedCount: 0, skippedCount: 0 })),
    })),
    createGroupVisibleDocumentRegistrar: vi.fn(() => ({
      registerDiscoveredLinks: vi.fn(async () => undefined),
    })),
    createProcessor: vi.fn(() => ({ process: vi.fn(async () => undefined) })),
    createWorkerLoop: vi.fn(() => ({
      start: vi.fn(),
      stop: vi.fn(async () => undefined),
      isRunning: vi.fn(() => false),
      getSnapshot: vi.fn(() => ({ running: false, intervalMs: 1000, batchLimit: 50 })),
    })),
  };
}

function documentSyncDependencies({ connect }: { connect: ReturnType<typeof vi.fn> }) {
  const pool = { query: vi.fn(), end: vi.fn(async () => undefined) };
  const redisClient = redisClientFixture({ connect });

  return {
    createPostgresPool: vi.fn(() => pool),
    createRedisClient: vi.fn(() => redisClient),
    createDocumentSourceRegistry: vi.fn(() => ({
      findSourceById: vi.fn(),
      listSources: vi.fn(async () => []),
      listSourcesByType: vi.fn(async () => []),
      listSourcesByGroupId: vi.fn(async () => []),
      listSourcesByAuthorizedSpaceId: vi.fn(async () => []),
      listSourcesBySubmittingUserId: vi.fn(async () => []),
      listSourcesUsableForAnswering: vi.fn(async () => []),
      listSourcesByAnsweringEnabled: vi.fn(async () => []),
      setAnsweringEnabled: vi.fn(),
      setKnowledgeDraftsEnabled: vi.fn(),
      updatePolicy: vi.fn(),
      markSyncState: vi.fn(),
      registerAuthorizedWikiDocument: vi.fn(),
      registerUserSubmittedDocument: vi.fn(),
    })),
    createDocumentSnapshotRepository: vi.fn(() => ({
      insertSucceededSnapshot: vi.fn(),
      insertFailedSnapshot: vi.fn(),
      findSnapshotById: vi.fn(),
      findLatestSnapshotForSource: vi.fn(),
      findLatestSnapshotsForSources: vi.fn(async () => []),
      listSnapshotsForSource: vi.fn(async () => []),
      listSuccessfulSnapshotsMissingProfile: vi.fn(async () => []),
    })),
    createFeishuTenantAccessTokenProvider: vi.fn(() => ({ getTenantAccessToken: vi.fn() })),
    createFeishuDocumentBodyFetcher: vi.fn(() => ({ fetch: vi.fn() })),
    createDocumentSyncQueue: vi.fn(() => ({
      enqueue: vi.fn(async () => undefined),
      dequeueBatch: vi.fn(async () => []),
      getPendingCount: vi.fn(async () => 0),
      handleProcessedJob: vi.fn(async () => undefined),
      handleFailedJob: vi.fn(),
      getDeadLetterCount: vi.fn(async () => 0),
      listDeadLetters: vi.fn(async () => []),
      replayDeadLetter: vi.fn(),
      deleteDeadLetter: vi.fn(),
      replayDeadLetters: vi.fn(),
    })),
    createDocumentReindexQueue: vi.fn(() => ({ enqueue: vi.fn(async () => undefined) })),
    createDocumentReindexPlanner: vi.fn(() => ({
      enqueueSyncedSnapshotReindex: vi.fn(async () => undefined),
    })),
    createManualDocumentSyncPlanner: vi.fn(() => ({ enqueueSource: vi.fn() })),
    createDocumentSyncRunner: vi.fn(() => ({ syncSourceById: vi.fn() })),
    createDocumentSyncWorker: vi.fn(() => ({ processBatch: vi.fn(async () => []) })),
    createWorkerLoop: vi.fn(() => ({
      start: vi.fn(),
      stop: vi.fn(async () => undefined),
      isRunning: vi.fn(() => false),
      getSnapshot: vi.fn(() => ({ running: false, intervalMs: 2500, batchLimit: 10 })),
    })),
  };
}

function reindexWorkerDependencies({
  redisConnect,
  findOrCreateProfile = vi.fn(async () => embeddingProfile()),
}: {
  redisConnect?: ReturnType<typeof vi.fn>;
  findOrCreateProfile?: ReturnType<typeof vi.fn>;
} = {}) {
  const pool = { query: vi.fn(), end: vi.fn(async () => undefined) };
  const redisClient = redisClientFixture({
    connect: redisConnect ?? vi.fn(async () => redisClient),
  });

  return {
    createPostgresPool: vi.fn(() => pool),
    createRedisClient: vi.fn(() => redisClient),
    createEmbeddingProfileRepository: vi.fn(() => ({
      findOrCreateProfile,
      getProfileById: vi.fn(async () => embeddingProfile()),
      getStaticDevelopmentProfile: vi.fn(),
    })),
    createDocumentSnapshotRepository: vi.fn(() => ({
      listSuccessfulSnapshotsMissingProfile: vi.fn(async () => []),
      findSnapshotById: vi.fn(),
    })),
    createDocumentFragmentRepository: vi.fn(() => ({
      replaceFragmentsForSnapshot: vi.fn(),
      hasFragmentsForSnapshotProfile: vi.fn(),
    })),
    createEmbeddingProvider: vi.fn(() => ({ embedTexts: vi.fn(async () => []) })),
    createWorkerLoop: vi.fn(() => ({
      start: vi.fn(),
      stop: vi.fn(async () => undefined),
      isRunning: vi.fn(() => false),
      getSnapshot: vi.fn(() => ({ running: false, intervalMs: 1000, batchLimit: 25 })),
    })),
  };
}

function redisClientFixture({ connect }: { connect: ReturnType<typeof vi.fn> }) {
  const redisClient = {
    connect,
    eval: vi.fn(async () => 1),
    rPush: vi.fn(async () => 1),
    lPop: vi.fn(async () => null),
    lLen: vi.fn(async () => 0),
    lRange: vi.fn(async () => []),
    lRem: vi.fn(async () => 1),
    sRem: vi.fn(),
    quit: vi.fn(async () => undefined),
  };

  return redisClient;
}

function knowledgeCardDependencies({ connect }: { connect: ReturnType<typeof vi.fn> }) {
  const pool = {
    query: vi.fn(),
    connect: vi.fn(),
    end: vi.fn(async () => undefined),
  };
  const redis = {
    connect,
    quit: vi.fn(async () => undefined),
    eval: vi.fn(async () => 1),
  };
  const repository = {
    createPresentation: vi.fn(),
    claimPresentationSend: vi.fn(async () => undefined),
    beginExternalAttempt: vi.fn(),
    failPresentationPreparation: vi.fn(),
    completePresentationSend: vi.fn(),
    failPresentationSend: vi.fn(),
    applyInteraction: vi.fn(),
    getPresentation: vi.fn(),
    getPresentationContext: vi.fn(),
    listPresentations: vi.fn(async () => []),
    getStatusCounts: vi.fn(async () => ({
      pending_send: 0,
      active: 0,
      superseded: 0,
      closed: 0,
      send_failed: 0,
      pendingSend: 0,
    })),
  };
  const loop = () => ({
    start: vi.fn(),
    stop: vi.fn(async () => undefined),
    isRunning: vi.fn(() => false),
    getSnapshot: vi.fn(() => ({ running: false, intervalMs: 1000, batchLimit: 10 })),
  });
  const dependencies = {
    createPostgresPool: vi.fn(() => pool),
    createRedisClient: vi.fn(() => redis),
    createKnowledgeDraftRepository: vi.fn(() => ({ getDraft: vi.fn() })),
    createKnowledgeCardRepository: vi.fn(() => repository),
    createFeishuTenantAccessTokenProvider: vi.fn(() => ({ getTenantAccessToken: vi.fn() })),
    createFeishuInteractiveCardClient: vi.fn(() => ({
      sendCard: vi.fn(),
      updateCard: vi.fn(),
    })),
    createFeishuGroupMembershipChecker: vi.fn(() => ({ isCurrentMember: vi.fn() })),
    createDispatcherLoop: vi.fn(loop),
    createInteractionLoop: vi.fn(loop),
  } satisfies KnowledgeCardRuntimeDependencies;
  return Object.assign(dependencies, { pool, redis });
}

function embeddingProfile() {
  return {
    id: "openai-compatible:text-embedding-small:1536",
    provider: "openai-compatible" as const,
    model: "text-embedding-small",
    dimensions: 1536,
    displayName: "OpenAI-compatible text-embedding-small (1536d)",
    status: "active" as const,
    createdAt: new Date("2026-07-02T01:00:00.000Z"),
  };
}
