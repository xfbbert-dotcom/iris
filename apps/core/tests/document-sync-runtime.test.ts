import { describe, expect, it, vi } from "vitest";

import type { SyncedSnapshotReindexer } from "../src/documents/document-sync-pipeline.js";
import { createDocumentSyncRuntime } from "../src/runtime/document-sync-runtime.js";

describe("createDocumentSyncRuntime", () => {
  it("returns undefined when the document sync worker is disabled", () => {
    expect(createDocumentSyncRuntime({ env: {} })).toBeUndefined();
  });

  it("preflights missing reindex embedding dimensions before opening resources", () => {
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
      createDocumentSyncRuntime({
        env: {
          ...enabledEnv(),
          IRIS_EMBEDDING_PROVIDER: "openai-compatible",
          IRIS_EMBEDDING_BASE_URL: "https://api.example.com/v1",
          IRIS_EMBEDDING_API_KEY: "key",
          IRIS_EMBEDDING_MODEL: "text-embedding-small",
          IRIS_EMBEDDING_DIMENSIONS: undefined,
        },
        dependencies: {
          createPostgresPool,
          createRedisClient,
        },
      }),
    ).toThrow("IRIS_EMBEDDING_DIMENSIONS is required when document sync reindex enqueue is enabled");

    expect(createPostgresPool).not.toHaveBeenCalled();
    expect(createRedisClient).not.toHaveBeenCalled();
    expect(redisClient.connect).not.toHaveBeenCalled();
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
      sRem: vi.fn(),
      quit: vi.fn(async () => undefined),
    };
    const inventorySource = {
      id: "source-1",
      sourceType: "authorized_wiki_document" as const,
      sourceUri: "https://docs.feishu.cn/docx/doc_token_1",
      title: "Handbook",
      originGroupId: undefined,
      originMessageId: undefined,
      submittedByUserId: undefined,
      authorizedSpaceId: "space-1",
      permissionState: "unknown" as const,
      syncState: "pending" as const,
      canUseForAnswering: true,
      canUseForKnowledgeDrafts: true,
      createdAt: new Date("2026-07-03T03:00:00.000Z"),
      updatedAt: new Date("2026-07-03T03:00:00.000Z"),
      evidence: [],
    };
    const userSubmittedSource = {
      id: "user-source-1",
      sourceType: "user_submitted_document" as const,
      sourceUri: "https://docs.feishu.cn/docx/user_doc_token_1",
      title: "User Guide",
      originGroupId: undefined,
      originMessageId: undefined,
      submittedByUserId: "ou_1",
      authorizedSpaceId: undefined,
      permissionState: "unknown" as const,
      syncState: "pending" as const,
      canUseForAnswering: true,
      canUseForKnowledgeDrafts: false,
      createdAt: new Date("2026-07-03T03:10:00.000Z"),
      updatedAt: new Date("2026-07-03T03:10:00.000Z"),
      evidence: [],
    };
    const snapshot = {
      id: "snapshot-1",
      documentSourceId: "source-1",
      sourceUri: "https://docs.feishu.cn/docx/doc_token_1",
      fetchStatus: "succeeded" as const,
      bodyText: "Document body",
      contentHash: "hash-1",
      sourceVersion: undefined,
      fetchedAt: new Date("2026-07-03T04:00:00.000Z"),
      errorMessage: undefined,
      createdAt: new Date("2026-07-03T04:00:01.000Z"),
    };
    const documentSources = {
      findSourceById: vi.fn(async () => inventorySource),
      listSources: vi.fn(async () => [inventorySource, userSubmittedSource]),
      listSourcesByType: vi.fn(async () => [inventorySource]),
      listSourcesByGroupId: vi.fn(async () => [inventorySource]),
      listSourcesByAuthorizedSpaceId: vi.fn(async () => [inventorySource]),
      listSourcesBySubmittingUserId: vi.fn(async () => [userSubmittedSource]),
      listSourcesUsableForAnswering: vi.fn(async () => [inventorySource, userSubmittedSource]),
      listSourcesByAnsweringEnabled: vi.fn(async (enabled: boolean) =>
        enabled ? [inventorySource, userSubmittedSource] : [],
      ),
      setAnsweringEnabled: vi.fn(async () => ({
        ...inventorySource,
        canUseForAnswering: false,
      })),
      setKnowledgeDraftsEnabled: vi.fn(async () => ({
        ...inventorySource,
        canUseForAnswering: false,
        canUseForKnowledgeDrafts: false,
      })),
      updatePolicy: vi.fn(async () => ({
        ...inventorySource,
        canUseForAnswering: false,
        canUseForKnowledgeDrafts: false,
      })),
      markSyncState: vi.fn(),
      registerAuthorizedWikiDocument: vi.fn(async () => inventorySource),
      registerUserSubmittedDocument: vi.fn(async () => userSubmittedSource),
    };
    const snapshots = {
      insertSucceededSnapshot: vi.fn(),
      insertFailedSnapshot: vi.fn(),
      findSnapshotById: vi.fn(async () => snapshot),
      findLatestSnapshotForSource: vi.fn(async () => snapshot),
      findLatestSnapshotsForSources: vi.fn(async () => [snapshot]),
      listSnapshotsForSource: vi.fn(async () => [snapshot]),
      listSuccessfulSnapshotsMissingProfile: vi.fn(async () => []),
    };
    const tokenProvider = {
      getTenantAccessToken: vi.fn(async () => "tenant-token"),
    };
    const fetcher = {
      fetch: vi.fn(),
    };
    const queue = {
      enqueue: vi.fn(async () => undefined),
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
    const manualPlanner = {
      enqueueSource: vi.fn(async (input: { documentSourceId: string }) => ({
        status: "enqueued" as const,
        documentSourceId: input.documentSourceId,
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
      createManualDocumentSyncPlanner: vi.fn(() => manualPlanner),
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
      timeoutMs: 7000,
    });
    expect(dependencies.createFeishuDocumentBodyFetcher).toHaveBeenCalledWith({
      baseUrl: "https://open.example.com",
      tokenProvider,
      timeoutMs: 7000,
      maxContentChars: 6000,
    });
    expect(dependencies.createDocumentSyncQueue).toHaveBeenCalledWith({
      eval: expect.any(Function),
      rPush: expect.any(Function),
      lPop: expect.any(Function),
      lLen: expect.any(Function),
      lRange: expect.any(Function),
      lRem: expect.any(Function),
      sRem: expect.any(Function),
    });
    expect(dependencies.createDocumentReindexQueue).toHaveBeenCalledWith({
      eval: expect.any(Function),
      rPush: expect.any(Function),
      lPop: expect.any(Function),
      lLen: expect.any(Function),
      lRange: expect.any(Function),
      lRem: expect.any(Function),
      sRem: expect.any(Function),
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
    expect(dependencies.createManualDocumentSyncPlanner).toHaveBeenCalledWith({
      registry: documentSources,
      queue,
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
    await expect(
      runtime?.enqueueSource({ documentSourceId: "source-1" }),
    ).resolves.toEqual({
      status: "enqueued",
      documentSourceId: "source-1",
    });
    expect(manualPlanner.enqueueSource).toHaveBeenCalledWith({
      documentSourceId: "source-1",
    });
    await expect(
      runtime?.registerAuthorizedWikiDocument({
        sourceUri: "https://docs.feishu.cn/docx/doc_token_1/?from=copy#heading",
        title: "Handbook",
        authorizedSpaceId: "space-1",
        observedAt: new Date("2026-07-03T03:00:00.000Z"),
      }),
    ).resolves.toEqual({
      source: {
        id: "source-1",
        sourceType: "authorized_wiki_document",
        sourceUri: "https://docs.feishu.cn/docx/doc_token_1",
        title: "Handbook",
        originGroupId: undefined,
        originMessageId: undefined,
        submittedByUserId: undefined,
        authorizedSpaceId: "space-1",
        permissionState: "unknown",
        syncState: "pending",
        canUseForAnswering: true,
        canUseForKnowledgeDrafts: true,
        createdAt: new Date("2026-07-03T03:00:00.000Z"),
        updatedAt: new Date("2026-07-03T03:00:00.000Z"),
        evidence: [],
      },
      enqueue: {
        status: "enqueued",
        documentSourceId: "source-1",
      },
    });
    expect(documentSources.registerAuthorizedWikiDocument).toHaveBeenCalledWith({
      sourceUri: "https://docs.feishu.cn/docx/doc_token_1",
      title: "Handbook",
      authorizedSpaceId: "space-1",
      observedAt: new Date("2026-07-03T03:00:00.000Z"),
    });
    expect(manualPlanner.enqueueSource).toHaveBeenCalledWith({
      documentSourceId: "source-1",
    });
    await expect(
      runtime?.registerUserSubmittedDocument({
        sourceUri: "https://docs.feishu.cn/docx/user_doc_token_1/?open=1#top",
        title: "User Guide",
        submittedByUserId: "ou_1",
        observedAt: new Date("2026-07-03T03:10:00.000Z"),
      }),
    ).resolves.toEqual({
      source: {
        id: "user-source-1",
        sourceType: "user_submitted_document",
        sourceUri: "https://docs.feishu.cn/docx/user_doc_token_1",
        title: "User Guide",
        originGroupId: undefined,
        originMessageId: undefined,
        submittedByUserId: "ou_1",
        authorizedSpaceId: undefined,
        permissionState: "unknown",
        syncState: "pending",
        canUseForAnswering: true,
        canUseForKnowledgeDrafts: false,
        createdAt: new Date("2026-07-03T03:10:00.000Z"),
        updatedAt: new Date("2026-07-03T03:10:00.000Z"),
        evidence: [],
      },
      enqueue: {
        status: "enqueued",
        documentSourceId: "user-source-1",
      },
    });
    expect(documentSources.registerUserSubmittedDocument).toHaveBeenCalledWith({
      sourceUri: "https://docs.feishu.cn/docx/user_doc_token_1",
      title: "User Guide",
      submittedByUserId: "ou_1",
      observedAt: new Date("2026-07-03T03:10:00.000Z"),
    });
    expect(manualPlanner.enqueueSource).toHaveBeenCalledWith({
      documentSourceId: "user-source-1",
    });
    const authorizedRegistrationCount = documentSources.registerAuthorizedWikiDocument.mock.calls.length;
    await expect(
      runtime?.registerAuthorizedWikiDocument({
        sourceUri: "http://docs.feishu.cn/docx/doc_token_1",
        authorizedSpaceId: "space-1",
        observedAt: new Date("2026-07-03T03:20:00.000Z"),
      }),
    ).rejects.toThrow("unsupported Feishu document source URI");
    expect(documentSources.registerAuthorizedWikiDocument).toHaveBeenCalledTimes(
      authorizedRegistrationCount,
    );
    const userSubmittedRegistrationCount =
      documentSources.registerUserSubmittedDocument.mock.calls.length;
    await expect(
      runtime?.registerUserSubmittedDocument({
        sourceUri: "http://docs.feishu.cn/docx/user_doc_token_1",
        submittedByUserId: "ou_1",
        observedAt: new Date("2026-07-03T03:30:00.000Z"),
      }),
    ).rejects.toThrow("unsupported Feishu document source URI");
    expect(documentSources.registerUserSubmittedDocument).toHaveBeenCalledTimes(
      userSubmittedRegistrationCount,
    );
    await expect(
      runtime?.registerUserSubmittedDocument({
        sourceUri: "https://docs.feishu.cn/docx/user_doc_token_1,please",
        submittedByUserId: "ou_1",
        observedAt: new Date("2026-07-03T03:35:00.000Z"),
      }),
    ).rejects.toThrow("unsupported Feishu document source URI");
    expect(documentSources.registerUserSubmittedDocument).toHaveBeenCalledTimes(
      userSubmittedRegistrationCount,
    );
    await expect(runtime?.sources.list({ limit: 1 })).resolves.toEqual([inventorySource]);
    expect(documentSources.listSources).toHaveBeenCalledOnce();
    documentSources.listSources.mockResolvedValueOnce(
      Array.from({ length: 101 }, (_, index) => ({
        ...inventorySource,
        id: `source-${index}`,
      })),
    );
    await expect(runtime?.sources.list({ limit: 101 })).resolves.toHaveLength(100);
    const listSourcesCountBeforeNonFiniteLimit = documentSources.listSources.mock.calls.length;
    await expect(
      runtime?.sources.list({ limit: Number.POSITIVE_INFINITY }),
    ).rejects.toThrow("document sync runtime list limit must be a finite safe-magnitude number");
    await expect(runtime?.sources.list({ limit: Number.NaN })).rejects.toThrow(
      "document sync runtime list limit must be a finite safe-magnitude number",
    );
    expect(documentSources.listSources).toHaveBeenCalledTimes(
      listSourcesCountBeforeNonFiniteLimit,
    );
    const listSourcesCountBeforeUnsafeLimit = documentSources.listSources.mock.calls.length;
    await expect(
      runtime?.sources.list({ limit: Number.MAX_SAFE_INTEGER + 1 }),
    ).rejects.toThrow("document sync runtime list limit must be a finite safe-magnitude number");
    expect(documentSources.listSources).toHaveBeenCalledTimes(listSourcesCountBeforeUnsafeLimit);
    await expect(
      runtime?.sources.list({ limit: 10, sourceType: "authorized_wiki_document" }),
    ).resolves.toEqual([inventorySource]);
    expect(documentSources.listSourcesByType).toHaveBeenCalledWith("authorized_wiki_document");
    await expect(runtime?.sources.list({ limit: 10, groupId: "group-1" })).resolves.toEqual([
      inventorySource,
    ]);
    expect(documentSources.listSourcesByGroupId).toHaveBeenCalledWith("group-1");
    await expect(runtime?.sources.list({ limit: 10, authorizedSpaceId: "space-1" })).resolves.toEqual([
      inventorySource,
    ]);
    expect(documentSources.listSourcesByAuthorizedSpaceId).toHaveBeenCalledWith("space-1");
    await expect(
      runtime?.sources.list({ limit: 10, submittedByUserId: "ou_1" }),
    ).resolves.toEqual([userSubmittedSource]);
    expect(documentSources.listSourcesBySubmittingUserId).toHaveBeenCalledWith("ou_1");
    await expect(
      runtime?.sources.list({ limit: 1, usableForAnswering: true }),
    ).resolves.toEqual([inventorySource]);
    expect(documentSources.listSourcesByAnsweringEnabled).toHaveBeenCalledWith(true);
    await expect(
      runtime?.sources.list({ limit: 1, usableForAnswering: false }),
    ).resolves.toEqual([]);
    expect(documentSources.listSourcesByAnsweringEnabled).toHaveBeenCalledWith(false);
    await expect(runtime?.sources.get("source-1")).resolves.toEqual(inventorySource);
    expect(documentSources.findSourceById).toHaveBeenCalledWith("source-1");
    await expect(
      runtime?.sources.updatePolicy({
        id: "source-1",
        canUseForAnswering: false,
        canUseForKnowledgeDrafts: false,
      }),
    ).resolves.toEqual({
      ...inventorySource,
      canUseForAnswering: false,
      canUseForKnowledgeDrafts: false,
    });
    expect(documentSources.findSourceById).toHaveBeenCalledWith("source-1");
    expect(documentSources.updatePolicy).toHaveBeenCalledWith("source-1", {
      canUseForAnswering: false,
      canUseForKnowledgeDrafts: false,
    });
    expect(documentSources.setAnsweringEnabled).not.toHaveBeenCalled();
    expect(documentSources.setKnowledgeDraftsEnabled).not.toHaveBeenCalled();
    await expect(
      runtime?.sources.listSnapshots({ id: "source-1", limit: 1 }),
    ).resolves.toEqual([snapshot]);
    snapshots.listSnapshotsForSource.mockResolvedValueOnce(
      Array.from({ length: 101 }, (_, index) => ({
        ...snapshot,
        id: `snapshot-${index}`,
      })),
    );
    await expect(
      runtime?.sources.listSnapshots({ id: "source-1", limit: 101 }),
    ).resolves.toHaveLength(100);
    const findSourceCountBeforeNonFiniteSnapshotLimit = documentSources.findSourceById.mock.calls.length;
    const listSnapshotsCountBeforeNonFiniteSnapshotLimit =
      snapshots.listSnapshotsForSource.mock.calls.length;
    await expect(
      runtime?.sources.listSnapshots({ id: "source-1", limit: Number.POSITIVE_INFINITY }),
    ).rejects.toThrow("document sync runtime list limit must be a finite safe-magnitude number");
    await expect(
      runtime?.sources.listSnapshots({ id: "source-1", limit: Number.NaN }),
    ).rejects.toThrow("document sync runtime list limit must be a finite safe-magnitude number");
    expect(documentSources.findSourceById).toHaveBeenCalledTimes(
      findSourceCountBeforeNonFiniteSnapshotLimit,
    );
    expect(snapshots.listSnapshotsForSource).toHaveBeenCalledTimes(
      listSnapshotsCountBeforeNonFiniteSnapshotLimit,
    );
    const findSourceCountBeforeUnsafeSnapshotLimit = documentSources.findSourceById.mock.calls.length;
    const listSnapshotsCountBeforeUnsafeSnapshotLimit =
      snapshots.listSnapshotsForSource.mock.calls.length;
    await expect(
      runtime?.sources.listSnapshots({
        id: "source-1",
        limit: Number.MAX_SAFE_INTEGER + 1,
      }),
    ).rejects.toThrow("document sync runtime list limit must be a finite safe-magnitude number");
    expect(documentSources.findSourceById).toHaveBeenCalledTimes(
      findSourceCountBeforeUnsafeSnapshotLimit,
    );
    expect(snapshots.listSnapshotsForSource).toHaveBeenCalledTimes(
      listSnapshotsCountBeforeUnsafeSnapshotLimit,
    );
    expect(documentSources.findSourceById).toHaveBeenCalledWith("source-1");
    expect(snapshots.listSnapshotsForSource).toHaveBeenCalledWith("source-1");
    await expect(
      runtime?.sources.getSnapshot({ sourceId: "source-1", snapshotId: "snapshot-1" }),
    ).resolves.toEqual(snapshot);
    expect(documentSources.findSourceById).toHaveBeenCalledWith("source-1");
    expect(snapshots.findSnapshotById).toHaveBeenCalledWith("snapshot-1");
    snapshots.findSnapshotById.mockResolvedValueOnce({
      ...snapshot,
      id: "snapshot-2",
      documentSourceId: "other-source",
    });
    await expect(
      runtime?.sources.getSnapshot({ sourceId: "source-1", snapshotId: "snapshot-2" }),
    ).resolves.toBeUndefined();
    await expect(
      runtime?.sources.getLatestSnapshot({ sourceId: "source-1" }),
    ).resolves.toEqual(snapshot);
    expect(documentSources.findSourceById).toHaveBeenCalledWith("source-1");
    expect(snapshots.findLatestSnapshotForSource).toHaveBeenCalledWith("source-1");
    const latestSnapshots = await runtime?.sources.getLatestSnapshots({
      sourceIds: ["source-1", "user-source-1"],
    });
    expect(latestSnapshots?.get("source-1")).toEqual(snapshot);
    expect(latestSnapshots?.has("user-source-1")).toBe(false);
    expect(snapshots.findLatestSnapshotsForSources).toHaveBeenCalledWith([
      "source-1",
      "user-source-1",
    ]);
    const latestSnapshotLookupCount =
      snapshots.findLatestSnapshotsForSources.mock.calls.length;
    const emptyLatestSnapshots = await runtime?.sources.getLatestSnapshots({ sourceIds: [] });
    expect(emptyLatestSnapshots?.size).toBe(0);
    expect(snapshots.findLatestSnapshotsForSources).toHaveBeenCalledTimes(
      latestSnapshotLookupCount,
    );

    loop.stop.mockRejectedValueOnce(new Error("document sync loop stop failed"));
    await expect(runtime?.close()).rejects.toThrow("document sync loop stop failed");
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
    IRIS_FEISHU_DOCUMENT_FETCH_TIMEOUT_MS: "7000",
    IRIS_FEISHU_DOCUMENT_MAX_CONTENT_CHARS: "6000",
    IRIS_EMBEDDING_PROVIDER: "openai-compatible",
    IRIS_EMBEDDING_BASE_URL: "https://api.example.com/v1",
    IRIS_EMBEDDING_API_KEY: "key",
    IRIS_EMBEDDING_MODEL: "text-embedding-small",
    IRIS_EMBEDDING_DIMENSIONS: "1536",
  };
}
