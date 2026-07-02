import { describe, expect, it, vi } from "vitest";

import type { SyncedSnapshotReindexer } from "../src/documents/document-sync-pipeline.js";
import { createDocumentSyncRuntime } from "../src/runtime/document-sync-runtime.js";

describe("createDocumentSyncRuntime", () => {
  it("returns undefined when the document sync worker is disabled", () => {
    expect(createDocumentSyncRuntime({ env: {} })).toBeUndefined();
  });

  it("composes Feishu document sync worker dependencies when enabled", async () => {
    const latestBatch = {
      status: "succeeded" as const,
      startedAt: new Date("2026-07-03T01:00:00.000Z"),
      finishedAt: new Date("2026-07-03T01:00:01.000Z"),
      processedCount: 2,
      failedCount: 1,
      failed: false as const,
    };
    const pool = { query: vi.fn(), end: vi.fn(async () => undefined) };
    const redisClient = {
      connect: vi.fn(async () => redisClient),
      eval: vi.fn(async () => 1),
      rPush: vi.fn(async () => 1),
      lPop: vi.fn(async () => null),
      lLen: vi.fn(async () => 0),
      lRange: vi.fn(async () => []),
      lRem: vi.fn(async () => 0),
      quit: vi.fn(async () => undefined),
    };
    const documentSources = {
      findSourceById: vi.fn(),
      markSyncState: vi.fn(),
    };
    const snapshots = {
      insertSucceededSnapshot: vi.fn(),
      insertFailedSnapshot: vi.fn(),
      listSuccessfulSnapshotsMissingProfile: vi.fn(async () => []),
    };
    const tokenProvider = {
      getTenantAccessToken: vi.fn(async () => "tenant-token"),
    };
    const fetcher = {
      fetch: vi.fn(),
    };
    const queue = {
      dequeueBatch: vi.fn(async () => []),
      getPendingCount: vi.fn(async () => 3),
      handleFailedJob: vi.fn(async () => ({ action: "requeued" as const, attempts: 1 })),
      getDeadLetterCount: vi.fn(async () => 2),
      listDeadLetters: vi.fn(async () => [
        {
          id: "dlq-1",
          job: {
            idempotencyKey: "document-sync:source-1",
            documentSourceId: "source-1",
            reason: "discovered_group_document" as const,
            enqueuedAt: new Date("2026-07-03T01:00:00.000Z"),
            attempts: 3,
          },
          errorMessage: "runner crashed",
          failedAt: new Date("2026-07-03T02:00:00.000Z"),
          replayable: true,
        },
      ]),
      replayDeadLetter: vi.fn(async () => "replayed" as const),
      deleteDeadLetter: vi.fn(async () => "deleted" as const),
      replayDeadLetters: vi.fn(async () => ({
        replayedCount: 1,
        notFoundIds: [],
        unsupportedLegacyIds: [],
      })),
    };
    const reindexQueue = {
      enqueue: vi.fn(async () => undefined),
    };
    const reindexPlanner = {
      planDocumentProfileReindex: vi.fn(async () => ({ enqueuedCount: 0, skippedCount: 0 })),
      enqueueSyncedSnapshotReindex: vi.fn(async () => undefined),
    };
    const runner = {
      syncSourceById: vi.fn(),
    };
    const worker = {
      processBatch: vi.fn(async () => []),
    };
    const loop = {
      start: vi.fn(),
      stop: vi.fn(async () => undefined),
      isRunning: vi.fn(() => true),
      getSnapshot: vi.fn(() => ({
        running: true,
        intervalMs: 2500,
        batchLimit: 4,
        latestBatch,
      })),
    };
    let runnerInput:
      | {
          syncedSnapshotReindexer?: SyncedSnapshotReindexer;
        }
      | undefined;
    const createDocumentSyncRunner = vi.fn((input) => {
      runnerInput = input;
      return runner;
    });
    const dependencies = {
      createPostgresPool: vi.fn(() => pool),
      createRedisClient: vi.fn(() => redisClient),
      createDocumentSourceRegistry: vi.fn(() => documentSources),
      createDocumentSnapshotRepository: vi.fn(() => snapshots),
      createFeishuTenantAccessTokenProvider: vi.fn(() => tokenProvider),
      createFeishuDocumentBodyFetcher: vi.fn(() => fetcher),
      createDocumentSyncQueue: vi.fn(() => queue),
      createDocumentReindexQueue: vi.fn(() => reindexQueue),
      createDocumentReindexPlanner: vi.fn(() => reindexPlanner),
      createDocumentSyncRunner,
      createDocumentSyncWorker: vi.fn(() => worker),
      createWorkerLoop: vi.fn(() => loop),
    };

    const runtime = createDocumentSyncRuntime({
      env: enabledEnv(),
      dependencies,
    });

    expect(runtime).toBeDefined();
    expect(dependencies.createPostgresPool).toHaveBeenCalledWith({
      databaseUrl: "postgres://example",
    });
    expect(dependencies.createRedisClient).toHaveBeenCalledWith("redis://localhost:6379");
    expect(dependencies.createDocumentSourceRegistry).toHaveBeenCalledWith(pool);
    expect(dependencies.createDocumentSnapshotRepository).toHaveBeenCalledWith({
      queryable: pool,
    });
    expect(dependencies.createFeishuTenantAccessTokenProvider).toHaveBeenCalledWith({
      baseUrl: "https://open.example.com",
      appId: "app-id",
      appSecret: "app-secret",
    });
    expect(dependencies.createFeishuDocumentBodyFetcher).toHaveBeenCalledWith({
      baseUrl: "https://open.example.com",
      tokenProvider,
    });
    expect(dependencies.createDocumentSyncQueue).toHaveBeenCalledWith({
      eval: expect.any(Function),
      rPush: expect.any(Function),
      lPop: expect.any(Function),
      lLen: expect.any(Function),
      lRange: expect.any(Function),
      lRem: expect.any(Function),
    });
    expect(dependencies.createDocumentReindexQueue).toHaveBeenCalledWith({
      eval: expect.any(Function),
      rPush: expect.any(Function),
      lPop: expect.any(Function),
      lLen: expect.any(Function),
      lRange: expect.any(Function),
      lRem: expect.any(Function),
    });
    expect(dependencies.createDocumentReindexPlanner).toHaveBeenCalledWith({
      snapshots,
      queue: reindexQueue,
    });
    expect(dependencies.createDocumentSyncRunner).toHaveBeenCalledWith({
      registry: documentSources,
      snapshots,
      fetcher,
      syncedSnapshotReindexer: {
        enqueueSyncedSnapshotReindex: expect.any(Function),
      },
    });
    await runnerInput?.syncedSnapshotReindexer?.enqueueSyncedSnapshotReindex({
      documentSnapshotId: "snapshot-1",
    });
    expect(reindexPlanner.enqueueSyncedSnapshotReindex).toHaveBeenCalledWith({
      embeddingProfileId: "openai-compatible:text-embedding-small:1536",
      documentSnapshotId: "snapshot-1",
    });
    expect(dependencies.createDocumentSyncWorker).toHaveBeenCalledWith({
      queue,
      runner,
    });
    expect(dependencies.createWorkerLoop).toHaveBeenCalledWith({
      worker,
      intervalMs: 2500,
      batchLimit: 4,
      onError: expect.any(Function),
    });

    runtime?.start();
    expect(loop.start).toHaveBeenCalledOnce();

    await expect(runtime?.getStatus()).resolves.toEqual({
      enabled: true,
      running: true,
      intervalMs: 2500,
      batchLimit: 4,
      pendingJobCount: 3,
      deadLetterJobCount: 2,
      latestBatch,
    });

    await expect(runtime?.deadLetters.list({ limit: 10 })).resolves.toEqual([
      {
        id: "dlq-1",
        job: {
          idempotencyKey: "document-sync:source-1",
          documentSourceId: "source-1",
          reason: "discovered_group_document",
          enqueuedAt: new Date("2026-07-03T01:00:00.000Z"),
          attempts: 3,
        },
        errorMessage: "runner crashed",
        failedAt: new Date("2026-07-03T02:00:00.000Z"),
        replayable: true,
      },
    ]);
    expect(queue.listDeadLetters).toHaveBeenCalledWith({ limit: 10 });
    await expect(runtime?.deadLetters.replay("dlq-1")).resolves.toBe("replayed");
    await expect(runtime?.deadLetters.delete("dlq-1")).resolves.toBe("deleted");
    await expect(runtime?.deadLetters.replayBatch({ ids: ["dlq-1"] })).resolves.toEqual({
      replayedCount: 1,
      notFoundIds: [],
      unsupportedLegacyIds: [],
    });

    await runtime?.close();
    expect(loop.stop).toHaveBeenCalledOnce();
    expect(redisClient.quit).toHaveBeenCalledOnce();
    expect(pool.end).toHaveBeenCalledOnce();
  });
});

function enabledEnv() {
  return {
    IRIS_DOCUMENT_SYNC_WORKER_ENABLED: "true",
    IRIS_DOCUMENT_SYNC_WORKER_INTERVAL_MS: "2500",
    IRIS_DOCUMENT_SYNC_WORKER_BATCH_LIMIT: "4",
    DATABASE_URL: "postgres://example",
    REDIS_URL: "redis://localhost:6379",
    FEISHU_APP_ID: "app-id",
    FEISHU_APP_SECRET: "app-secret",
    FEISHU_OPEN_BASE_URL: "https://open.example.com/",
    IRIS_EMBEDDING_PROVIDER: "openai-compatible",
    IRIS_EMBEDDING_BASE_URL: "https://api.example.com/v1",
    IRIS_EMBEDDING_API_KEY: "key",
    IRIS_EMBEDDING_MODEL: "text-embedding-small",
    IRIS_EMBEDDING_DIMENSIONS: "1536",
  };
}
