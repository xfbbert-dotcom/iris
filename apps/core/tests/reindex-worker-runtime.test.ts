import { describe, expect, it, vi } from "vitest";

import { createReindexWorkerRuntime } from "../src/runtime/reindex-worker-runtime.js";

describe("createReindexWorkerRuntime", () => {
  it("returns undefined when the reindex worker is disabled", () => {
    expect(createReindexWorkerRuntime({ env: {} })).toBeUndefined();
  });

  it("composes Redis, repositories, planner, worker, and loop when enabled", async () => {
    const pool = { query: vi.fn(), end: vi.fn(async () => undefined) };
    const redisClient = {
      connect: vi.fn(async () => redisClient),
      eval: vi.fn(async () => 1),
      rPush: vi.fn(async () => 1),
      lPop: vi.fn(async () => null),
      lLen: vi.fn().mockResolvedValueOnce(42).mockResolvedValueOnce(5),
      lRange: vi.fn(async () => []),
      lRem: vi.fn(async () => 1),
      sRem: vi.fn(),
      quit: vi.fn(async () => undefined),
    };
    const embeddingProfile = embeddingProfileFixture();
    const snapshots = {
      listSuccessfulSnapshotsMissingProfile: vi.fn(async () => []),
      findSnapshotById: vi.fn(),
    };
    const fragments = {
      replaceFragmentsForSnapshot: vi.fn(),
      hasFragmentsForSnapshotProfile: vi.fn(),
    };
    const loop = {
      start: vi.fn(),
      stop: vi.fn(async () => undefined),
      isRunning: vi.fn(() => false),
      getSnapshot: vi.fn(() => ({
        running: true,
        intervalMs: 1000,
        batchLimit: 25,
        latestBatch: {
          status: "succeeded" as const,
          startedAt: new Date("2026-07-02T01:00:00.000Z"),
          finishedAt: new Date("2026-07-02T01:00:01.000Z"),
          indexedCount: 2,
          skippedCount: 1,
          failedCount: 0,
          failed: false as const,
        },
      })),
    };

    const runtime = createReindexWorkerRuntime({
      env: enabledEnv(),
      dependencies: {
        createPostgresPool: vi.fn(() => pool),
        createRedisClient: vi.fn(() => redisClient),
        createEmbeddingProfileRepository: vi.fn(() => ({
          findOrCreateProfile: vi.fn(async () => embeddingProfile),
          getProfileById: vi.fn(async () => embeddingProfile),
          getStaticDevelopmentProfile: vi.fn(),
        })),
        createDocumentSnapshotRepository: vi.fn(() => snapshots),
        createDocumentFragmentRepository: vi.fn(() => fragments),
        createEmbeddingProvider: vi.fn(() => ({ embedTexts: vi.fn(async () => []) })),
        createWorkerLoop: vi.fn(() => loop),
      },
    });

    expect(runtime).toBeDefined();
    expect(runtime?.activeEmbeddingProfileId).toBe("openai-compatible:text-embedding-small:1536");

    await expect(
      runtime?.planner.planDocumentProfileReindex({
        embeddingProfileId: "openai-compatible:text-embedding-small:1536",
        limit: 10,
      }),
    ).resolves.toEqual({ enqueuedCount: 0, skippedCount: 0 });
    expect(redisClient.eval).not.toHaveBeenCalled();

    runtime?.start();
    expect(loop.start).toHaveBeenCalledOnce();

    await expect(runtime?.getStatus()).resolves.toEqual({
      enabled: true,
      running: true,
      activeEmbeddingProfileId: "openai-compatible:text-embedding-small:1536",
      intervalMs: 1000,
      batchLimit: 25,
      pendingJobCount: 42,
      deadLetterJobCount: 5,
      latestBatch: {
        status: "succeeded",
        startedAt: new Date("2026-07-02T01:00:00.000Z"),
        finishedAt: new Date("2026-07-02T01:00:01.000Z"),
        indexedCount: 2,
        skippedCount: 1,
        failedCount: 0,
        failed: false,
      },
    });
    await expect(runtime?.deadLetters.list({ limit: 20 })).resolves.toEqual([]);
    expect(redisClient.lRange).toHaveBeenCalledWith("iris:reindex:documents:dlq", 0, 19);

    await runtime?.close();
    expect(loop.stop).toHaveBeenCalledOnce();
    expect(redisClient.quit).toHaveBeenCalledOnce();
    expect(pool.end).toHaveBeenCalledOnce();
  });

  it("rejects planner calls for non-active embedding profiles", async () => {
    const runtime = createReindexWorkerRuntime({
      env: enabledEnv(),
      dependencies: runtimeDependencies(),
    });

    await expect(
      runtime?.planner.planDocumentProfileReindex({
        embeddingProfileId: "other-profile",
        limit: 10,
      }),
    ).rejects.toThrow("embeddingProfileId does not match active reindex profile");
  });

  it("requires embedding provider config when enabled", () => {
    expect(() =>
      createReindexWorkerRuntime({
        env: {
          IRIS_REINDEX_WORKER_ENABLED: "true",
          DATABASE_URL: "postgres://example",
        },
        dependencies: runtimeDependencies(),
      }),
    ).toThrow("IRIS_EMBEDDING_PROVIDER is required when reindex worker is enabled");
  });

  it("requires supported embedding dimensions when enabled", () => {
    expect(() =>
      createReindexWorkerRuntime({
        env: {
          ...enabledEnv(),
          IRIS_EMBEDDING_DIMENSIONS: "3072",
        },
        dependencies: runtimeDependencies(),
      }),
    ).toThrow("Unsupported embedding dimension: 3072");
  });
});

function enabledEnv() {
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

function embeddingProfileFixture() {
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

function runtimeDependencies() {
  const embeddingProfile = embeddingProfileFixture();
  const pool = { query: vi.fn(), end: vi.fn(async () => undefined) };
  const redisClient = {
    connect: vi.fn(async () => redisClient),
    eval: vi.fn(async () => 1),
    rPush: vi.fn(async () => 1),
    lPop: vi.fn(async () => null),
    lLen: vi.fn(async () => 0),
    lRange: vi.fn(async () => []),
    lRem: vi.fn(async () => 1),
    sRem: vi.fn(),
    quit: vi.fn(async () => undefined),
  };

  return {
    createPostgresPool: vi.fn(() => pool),
    createRedisClient: vi.fn(() => redisClient),
    createEmbeddingProfileRepository: vi.fn(() => ({
      findOrCreateProfile: vi.fn(async () => embeddingProfile),
      getProfileById: vi.fn(async () => embeddingProfile),
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
