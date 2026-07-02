import { describe, expect, it, vi } from "vitest";

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
    const documentSources = {
      findSourceById: vi.fn(),
      markSyncState: vi.fn(),
    };
    const snapshots = {
      insertSucceededSnapshot: vi.fn(),
      insertFailedSnapshot: vi.fn(),
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
    const dependencies = {
      createPostgresPool: vi.fn(() => pool),
      createDocumentSourceRegistry: vi.fn(() => documentSources),
      createDocumentSnapshotRepository: vi.fn(() => snapshots),
      createFeishuTenantAccessTokenProvider: vi.fn(() => tokenProvider),
      createFeishuDocumentBodyFetcher: vi.fn(() => fetcher),
      createDocumentSyncQueue: vi.fn(() => queue),
      createDocumentSyncRunner: vi.fn(() => runner),
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
    expect(dependencies.createDocumentSyncQueue).toHaveBeenCalledWith();
    expect(dependencies.createDocumentSyncRunner).toHaveBeenCalledWith({
      registry: documentSources,
      snapshots,
      fetcher,
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
      latestBatch,
    });

    await runtime?.close();
    expect(loop.stop).toHaveBeenCalledOnce();
    expect(pool.end).toHaveBeenCalledOnce();
  });
});

function enabledEnv() {
  return {
    IRIS_DOCUMENT_SYNC_WORKER_ENABLED: "true",
    IRIS_DOCUMENT_SYNC_WORKER_INTERVAL_MS: "2500",
    IRIS_DOCUMENT_SYNC_WORKER_BATCH_LIMIT: "4",
    DATABASE_URL: "postgres://example",
    FEISHU_APP_ID: "app-id",
    FEISHU_APP_SECRET: "app-secret",
    FEISHU_OPEN_BASE_URL: "https://open.example.com/",
  };
}
