import { describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import type { DocumentSyncRuntime } from "../src/runtime/document-sync-runtime.js";
import type { EventWorkerRuntime } from "../src/runtime/event-worker-runtime.js";
import type { ReindexWorkerRuntime } from "../src/runtime/reindex-worker-runtime.js";

describe("POST /internal/answer-drafts", () => {
  it("calls the injected orchestrator and returns draft metadata", async () => {
    const answerDraftOrchestrator = {
      generateDraft: vi.fn(async () => ({
        answerText: "Draft answer.",
        promptContext: "<live_chat_context></live_chat_context>",
        allowedFragments: [
          {
            id: "fragment-1",
            documentSourceId: "source-1",
            documentSnapshotId: "snapshot-1",
            sourceUri: "https://example.com/doc",
            chunkIndex: 0,
            text: "Evidence text",
            contentHash: "hash",
            embedding: [1, 0, 0, 0, 0, 0],
            embeddingProfileId: "static-dev-6d",
            createdAt: new Date("2026-07-02T01:00:00.000Z"),
            distance: 0.12,
          },
        ],
        deniedDocumentIds: ["source-denied"],
        retrievedFragmentCount: 2,
      })),
    };
    const app = buildApp({ answerDraftOrchestrator });

    const response = await app.inject({
      method: "POST",
      url: "/internal/answer-drafts",
      payload: {
        question: "What changed?",
        liveChatMessages: [{ speaker: "Alice", text: "Please answer." }],
        fragmentLimit: 4,
        liveChatLimit: 10,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(answerDraftOrchestrator.generateDraft).toHaveBeenCalledWith({
      question: "What changed?",
      liveChatMessages: [{ speaker: "Alice", text: "Please answer." }],
      fragmentLimit: 4,
      liveChatLimit: 10,
    });
    expect(response.json()).toEqual({
      answerText: "Draft answer.",
      promptContext: "<live_chat_context></live_chat_context>",
      allowedFragments: [
        {
          id: "fragment-1",
          documentSourceId: "source-1",
          documentSnapshotId: "snapshot-1",
          sourceUri: "https://example.com/doc",
          chunkIndex: 0,
          text: "Evidence text",
          contentHash: "hash",
          embedding: [1, 0, 0, 0, 0, 0],
          embeddingProfileId: "static-dev-6d",
          createdAt: "2026-07-02T01:00:00.000Z",
          distance: 0.12,
        },
      ],
      deniedDocumentIds: ["source-denied"],
      retrievedFragmentCount: 2,
    });
  });

  it("returns 503 when no orchestrator is configured", async () => {
    const app = buildApp();

    const response = await app.inject({
      method: "POST",
      url: "/internal/answer-drafts",
      payload: {
        question: "What changed?",
        liveChatMessages: [],
      },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      ok: false,
      error: "answer_draft_orchestrator_unavailable",
    });
  });

  it("returns 400 for invalid requests", async () => {
    const app = buildApp({
      answerDraftOrchestrator: { generateDraft: vi.fn() },
    });

    const response = await app.inject({
      method: "POST",
      url: "/internal/answer-drafts",
      payload: {
        question: " ",
        liveChatMessages: [{ speaker: "Alice", text: "Please answer." }],
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ ok: false, error: "invalid_request" });
  });

  it("returns 500 when draft generation fails", async () => {
    const app = buildApp({
      answerDraftOrchestrator: {
        generateDraft: vi.fn(async () => {
          throw new Error("model unavailable");
        }),
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/internal/answer-drafts",
      payload: {
        question: "What changed?",
        liveChatMessages: [],
      },
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ ok: false, error: "answer_draft_failed" });
  });
});

describe("answer draft runtime wiring", () => {
  it("uses injected orchestrator without composing runtime", async () => {
    const createAnswerDraftRuntime = vi.fn(() => {
      throw new Error("should not compose runtime");
    });
    const app = buildApp({
      createAnswerDraftRuntime,
      answerDraftOrchestrator: {
        generateDraft: vi.fn(async () => ({
          answerText: "Injected draft",
          promptContext: "",
          allowedFragments: [],
          deniedDocumentIds: [],
          retrievedFragmentCount: 0,
        })),
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/internal/answer-drafts",
      payload: { question: "Q", liveChatMessages: [] },
    });

    expect(response.statusCode).toBe(200);
    expect(createAnswerDraftRuntime).not.toHaveBeenCalled();
  });

  it("uses composed runtime when no orchestrator is injected", async () => {
    const close = vi.fn(async () => undefined);
    const app = buildApp({
      createAnswerDraftRuntime: vi.fn(() => ({
        answerDraftOrchestrator: {
          generateDraft: vi.fn(async () => ({
            answerText: "Runtime draft",
            promptContext: "",
            allowedFragments: [],
            deniedDocumentIds: [],
            retrievedFragmentCount: 0,
          })),
        },
        close,
      })),
    });

    const response = await app.inject({
      method: "POST",
      url: "/internal/answer-drafts",
      payload: { question: "Q", liveChatMessages: [] },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().answerText).toBe("Runtime draft");

    await app.close();
    expect(close).toHaveBeenCalled();
  });

  it("starts and closes an injected reindex worker runtime", async () => {
    const reindexWorkerRuntime = fakeReindexRuntime();
    const app = buildApp({
      createAnswerDraftRuntime: () => undefined,
      createReindexWorkerRuntime: () => reindexWorkerRuntime,
    });

    expect(reindexWorkerRuntime.start).toHaveBeenCalledOnce();
    await app.close();
    expect(reindexWorkerRuntime.close).toHaveBeenCalledOnce();
  });

  it("starts and closes an injected document sync runtime", async () => {
    const documentSyncRuntime = fakeDocumentSyncRuntime();
    const app = buildApp({
      createAnswerDraftRuntime: () => undefined,
      createReindexWorkerRuntime: () => undefined,
      createDocumentSyncRuntime: () => documentSyncRuntime,
    });

    expect(documentSyncRuntime.start).toHaveBeenCalledOnce();
    await app.close();
    expect(documentSyncRuntime.close).toHaveBeenCalledOnce();
  });
});

describe("POST /internal/reindex/document-profile", () => {
  it("returns 503 when reindex runtime is unavailable", async () => {
    const app = buildApp({
      createAnswerDraftRuntime: () => undefined,
      createReindexWorkerRuntime: () => undefined,
    });

    const response = await app.inject({
      method: "POST",
      url: "/internal/reindex/document-profile",
      payload: {
        embeddingProfileId: "openai-compatible:text-embedding-small:1536",
        limit: 10,
      },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ ok: false, error: "reindex_worker_unavailable" });
  });

  it("returns 400 for invalid reindex requests", async () => {
    const app = buildApp({
      createAnswerDraftRuntime: () => undefined,
      createReindexWorkerRuntime: () => fakeReindexRuntime(),
    });

    const response = await app.inject({
      method: "POST",
      url: "/internal/reindex/document-profile",
      payload: { embeddingProfileId: " ", limit: 0 },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ ok: false, error: "invalid_request" });
  });

  it("rejects profile ids that do not match the active runtime profile", async () => {
    const app = buildApp({
      createAnswerDraftRuntime: () => undefined,
      createReindexWorkerRuntime: () => fakeReindexRuntime(),
    });

    const response = await app.inject({
      method: "POST",
      url: "/internal/reindex/document-profile",
      payload: { embeddingProfileId: "other-profile", limit: 10 },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ ok: false, error: "invalid_request" });
  });

  it("plans document profile reindex jobs", async () => {
    const runtime = fakeReindexRuntime();
    const app = buildApp({
      createAnswerDraftRuntime: () => undefined,
      createReindexWorkerRuntime: () => runtime,
    });

    const response = await app.inject({
      method: "POST",
      url: "/internal/reindex/document-profile",
      payload: {
        embeddingProfileId: "openai-compatible:text-embedding-small:1536",
        limit: 10,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, enqueuedCount: 2, skippedCount: 0 });
    expect(runtime.planner.planDocumentProfileReindex).toHaveBeenCalledWith({
      embeddingProfileId: "openai-compatible:text-embedding-small:1536",
      limit: 10,
    });
  });

  it("returns 500 when reindex planning fails", async () => {
    const runtime = fakeReindexRuntime({
      planner: {
        planDocumentProfileReindex: vi.fn(async () => {
          throw new Error("planner failed");
        }),
      },
    });
    const app = buildApp({
      createAnswerDraftRuntime: () => undefined,
      createReindexWorkerRuntime: () => runtime,
    });

    const response = await app.inject({
      method: "POST",
      url: "/internal/reindex/document-profile",
      payload: {
        embeddingProfileId: "openai-compatible:text-embedding-small:1536",
        limit: 10,
      },
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ ok: false, error: "reindex_plan_failed" });
  });
});

describe("GET /internal/reindex/status", () => {
  it("returns disabled status when reindex runtime is unavailable", async () => {
    const app = buildApp({
      createAnswerDraftRuntime: () => undefined,
      createReindexWorkerRuntime: () => undefined,
    });

    const response = await app.inject({
      method: "GET",
      url: "/internal/reindex/status",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, enabled: false, running: false });
  });

  it("returns reindex runtime status", async () => {
    const runtime = fakeReindexRuntime({
      getStatus: vi.fn(async () => ({
        enabled: true as const,
        running: true,
        activeEmbeddingProfileId: "openai-compatible:text-embedding-small:1536",
        intervalMs: 1000,
        batchLimit: 25,
        pendingJobCount: 7,
        deadLetterJobCount: 4,
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
    });
    const app = buildApp({
      createAnswerDraftRuntime: () => undefined,
      createReindexWorkerRuntime: () => runtime,
    });

    const response = await app.inject({
      method: "GET",
      url: "/internal/reindex/status",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      enabled: true,
      running: true,
      activeEmbeddingProfileId: "openai-compatible:text-embedding-small:1536",
      intervalMs: 1000,
      batchLimit: 25,
      pendingJobCount: 7,
      deadLetterJobCount: 4,
      latestBatch: {
        status: "succeeded",
        startedAt: "2026-07-02T01:00:00.000Z",
        finishedAt: "2026-07-02T01:00:01.000Z",
        indexedCount: 2,
        skippedCount: 1,
        failedCount: 0,
        failed: false,
      },
    });
  });

  it("returns 500 when reindex status lookup fails", async () => {
    const runtime = fakeReindexRuntime({
      getStatus: vi.fn(async () => {
        throw new Error("redis unavailable");
      }),
    });
    const app = buildApp({
      createAnswerDraftRuntime: () => undefined,
      createReindexWorkerRuntime: () => runtime,
    });

    const response = await app.inject({
      method: "GET",
      url: "/internal/reindex/status",
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ ok: false, error: "reindex_status_failed" });
  });
});

describe("reindex dead-letter API", () => {
  it("returns 503 when reindex runtime is unavailable", async () => {
    const app = buildApp({
      createAnswerDraftRuntime: () => undefined,
      createReindexWorkerRuntime: () => undefined,
    });

    const response = await app.inject({
      method: "GET",
      url: "/internal/reindex/dead-letters",
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ ok: false, error: "reindex_worker_unavailable" });
  });

  it("lists reindex dead letters", async () => {
    const runtime = fakeReindexRuntime({
      deadLetters: {
        list: vi.fn(async () => [
          {
            id: "dlq-1",
            job: {
              idempotencyKey: "reindex:profile-1536:snapshot-1",
              embeddingProfileId: "profile-1536",
              documentSnapshotId: "snapshot-1",
              reason: "manual_profile_reindex" as const,
              enqueuedAt: new Date("2026-07-02T01:00:00.000Z"),
              attempts: 3,
            },
            errorMessage: "embedding failed",
            failedAt: new Date("2026-07-02T01:05:00.000Z"),
            replayable: true,
          },
        ]),
        replay: vi.fn(),
        delete: vi.fn(),
        replayBatch: vi.fn(),
      },
    });
    const app = buildApp({
      createAnswerDraftRuntime: () => undefined,
      createReindexWorkerRuntime: () => runtime,
    });

    const response = await app.inject({
      method: "GET",
      url: "/internal/reindex/dead-letters?limit=20",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      deadLetters: [
        {
          id: "dlq-1",
          job: {
            idempotencyKey: "reindex:profile-1536:snapshot-1",
            embeddingProfileId: "profile-1536",
            documentSnapshotId: "snapshot-1",
            reason: "manual_profile_reindex",
            enqueuedAt: "2026-07-02T01:00:00.000Z",
            attempts: 3,
          },
          errorMessage: "embedding failed",
          failedAt: "2026-07-02T01:05:00.000Z",
          replayable: true,
        },
      ],
    });
    expect(runtime.deadLetters.list).toHaveBeenCalledWith({ limit: 20 });
  });

  it("rejects invalid dead-letter list limits", async () => {
    const app = buildApp({
      createAnswerDraftRuntime: () => undefined,
      createReindexWorkerRuntime: () => fakeReindexRuntime(),
    });

    const response = await app.inject({
      method: "GET",
      url: "/internal/reindex/dead-letters?limit=-1",
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ ok: false, error: "invalid_request" });
  });

  it("replays a reindex dead letter", async () => {
    const runtime = fakeReindexRuntime({
      deadLetters: {
        list: vi.fn(),
        replay: vi.fn(async () => "replayed" as const),
        delete: vi.fn(),
        replayBatch: vi.fn(),
      },
    });
    const app = buildApp({
      createAnswerDraftRuntime: () => undefined,
      createReindexWorkerRuntime: () => runtime,
    });

    const response = await app.inject({
      method: "POST",
      url: "/internal/reindex/dead-letters/dlq-1/replay",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, status: "replayed" });
    expect(runtime.deadLetters.replay).toHaveBeenCalledWith("dlq-1");
  });

  it("deletes a reindex dead letter", async () => {
    const runtime = fakeReindexRuntime({
      deadLetters: {
        list: vi.fn(),
        replay: vi.fn(),
        delete: vi.fn(async () => "deleted" as const),
        replayBatch: vi.fn(),
      },
    });
    const app = buildApp({
      createAnswerDraftRuntime: () => undefined,
      createReindexWorkerRuntime: () => runtime,
    });

    const response = await app.inject({
      method: "DELETE",
      url: "/internal/reindex/dead-letters/dlq-1",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, status: "deleted" });
    expect(runtime.deadLetters.delete).toHaveBeenCalledWith("dlq-1");
  });

  it("batch replays reindex dead letters", async () => {
    const runtime = fakeReindexRuntime({
      deadLetters: {
        list: vi.fn(),
        replay: vi.fn(),
        delete: vi.fn(),
        replayBatch: vi.fn(async () => ({
          replayedCount: 1,
          notFoundIds: ["missing"],
          unsupportedLegacyIds: ["legacy:0:abc"],
        })),
      },
    });
    const app = buildApp({
      createAnswerDraftRuntime: () => undefined,
      createReindexWorkerRuntime: () => runtime,
    });

    const response = await app.inject({
      method: "POST",
      url: "/internal/reindex/dead-letters/replay",
      payload: { ids: ["dlq-1", "missing", "legacy:0:abc"] },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      replayedCount: 1,
      notFoundIds: ["missing"],
      unsupportedLegacyIds: ["legacy:0:abc"],
    });
    expect(runtime.deadLetters.replayBatch).toHaveBeenCalledWith({
      ids: ["dlq-1", "missing", "legacy:0:abc"],
    });
  });

  it("rejects invalid batch replay requests", async () => {
    const app = buildApp({
      createAnswerDraftRuntime: () => undefined,
      createReindexWorkerRuntime: () => fakeReindexRuntime(),
    });

    const response = await app.inject({
      method: "POST",
      url: "/internal/reindex/dead-letters/replay",
      payload: { ids: [] },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ ok: false, error: "invalid_request" });
  });

  it("returns 500 when dead-letter operations fail", async () => {
    const runtime = fakeReindexRuntime({
      deadLetters: {
        list: vi.fn(async () => {
          throw new Error("redis unavailable");
        }),
        replay: vi.fn(),
        delete: vi.fn(),
        replayBatch: vi.fn(),
      },
    });
    const app = buildApp({
      createAnswerDraftRuntime: () => undefined,
      createReindexWorkerRuntime: () => runtime,
    });

    const response = await app.inject({
      method: "GET",
      url: "/internal/reindex/dead-letters",
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      ok: false,
      error: "reindex_dead_letter_operation_failed",
    });
  });
});

describe("GET /internal/events/status", () => {
  it("returns disabled status when event runtime is unavailable", async () => {
    const app = buildApp({
      createAnswerDraftRuntime: () => undefined,
      createReindexWorkerRuntime: () => undefined,
      createEventWorkerRuntime: () => undefined,
    });

    const response = await app.inject({
      method: "GET",
      url: "/internal/events/status",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, enabled: false, running: false });
  });

  it("returns event worker runtime status", async () => {
    const runtime = fakeEventRuntime({
      getStatus: vi.fn(async () => ({
        enabled: true as const,
        running: true,
        intervalMs: 1000,
        batchLimit: 50,
        pendingEventCount: 7,
        deadLetterEventCount: 2,
        latestBatch: {
          status: "succeeded" as const,
          startedAt: new Date("2026-07-02T01:00:00.000Z"),
          finishedAt: new Date("2026-07-02T01:00:01.000Z"),
          processedCount: 3,
          failedCount: 1,
          failed: false as const,
        },
      })),
    });
    const app = buildApp({
      createAnswerDraftRuntime: () => undefined,
      createReindexWorkerRuntime: () => undefined,
      createEventWorkerRuntime: () => runtime,
    });

    const response = await app.inject({
      method: "GET",
      url: "/internal/events/status",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      enabled: true,
      running: true,
      intervalMs: 1000,
      batchLimit: 50,
      pendingEventCount: 7,
      deadLetterEventCount: 2,
      latestBatch: {
        status: "succeeded",
        startedAt: "2026-07-02T01:00:00.000Z",
        finishedAt: "2026-07-02T01:00:01.000Z",
        processedCount: 3,
        failedCount: 1,
        failed: false,
      },
    });
  });

  it("returns 500 when event status lookup fails", async () => {
    const runtime = fakeEventRuntime({
      getStatus: vi.fn(async () => {
        throw new Error("redis unavailable");
      }),
    });
    const app = buildApp({
      createAnswerDraftRuntime: () => undefined,
      createReindexWorkerRuntime: () => undefined,
      createEventWorkerRuntime: () => runtime,
    });

    const response = await app.inject({
      method: "GET",
      url: "/internal/events/status",
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ ok: false, error: "event_worker_status_failed" });
  });
});

describe("GET /internal/document-sync/status", () => {
  it("returns disabled status when document sync runtime is unavailable", async () => {
    const app = buildApp({
      createAnswerDraftRuntime: () => undefined,
      createReindexWorkerRuntime: () => undefined,
      createEventWorkerRuntime: () => undefined,
      createDocumentSyncRuntime: () => undefined,
    });

    const response = await app.inject({
      method: "GET",
      url: "/internal/document-sync/status",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, enabled: false, running: false });
  });

  it("returns document sync runtime status", async () => {
    const runtime = fakeDocumentSyncRuntime({
      getStatus: vi.fn(async () => ({
        enabled: true as const,
        running: true,
        intervalMs: 1000,
        batchLimit: 10,
        pendingJobCount: 5,
        deadLetterJobCount: 2,
        latestBatch: {
          status: "succeeded" as const,
          startedAt: new Date("2026-07-03T01:00:00.000Z"),
          finishedAt: new Date("2026-07-03T01:00:01.000Z"),
          processedCount: 4,
          failedCount: 1,
          failed: false as const,
        },
      })),
    });
    const app = buildApp({
      createAnswerDraftRuntime: () => undefined,
      createReindexWorkerRuntime: () => undefined,
      createEventWorkerRuntime: () => undefined,
      createDocumentSyncRuntime: () => runtime,
    });

    const response = await app.inject({
      method: "GET",
      url: "/internal/document-sync/status",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      enabled: true,
      running: true,
      intervalMs: 1000,
      batchLimit: 10,
      pendingJobCount: 5,
      deadLetterJobCount: 2,
      latestBatch: {
        status: "succeeded",
        startedAt: "2026-07-03T01:00:00.000Z",
        finishedAt: "2026-07-03T01:00:01.000Z",
        processedCount: 4,
        failedCount: 1,
        failed: false,
      },
    });
  });

  it("returns 500 when document sync status lookup fails", async () => {
    const runtime = fakeDocumentSyncRuntime({
      getStatus: vi.fn(async () => {
        throw new Error("redis unavailable");
      }),
    });
    const app = buildApp({
      createAnswerDraftRuntime: () => undefined,
      createReindexWorkerRuntime: () => undefined,
      createEventWorkerRuntime: () => undefined,
      createDocumentSyncRuntime: () => runtime,
    });

    const response = await app.inject({
      method: "GET",
      url: "/internal/document-sync/status",
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ ok: false, error: "document_sync_status_failed" });
  });
});

describe("document sync source inventory API", () => {
  it("returns 503 when listing sources without document sync runtime", async () => {
    const app = buildApp({
      createAnswerDraftRuntime: () => undefined,
      createDocumentSyncRuntime: () => undefined,
    });

    const response = await app.inject({
      method: "GET",
      url: "/internal/document-sync/sources",
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ ok: false, error: "document_sync_worker_unavailable" });
  });

  it("lists document sources", async () => {
    const runtime = fakeDocumentSyncRuntime({
      sources: {
        list: vi.fn(async () => [authorizedWikiSource(), userSubmittedSource()]),
        get: vi.fn(),
      },
    });
    const app = buildApp({
      createAnswerDraftRuntime: () => undefined,
      createDocumentSyncRuntime: () => runtime,
    });

    const response = await app.inject({
      method: "GET",
      url: "/internal/document-sync/sources?limit=2",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      sources: [
        {
          id: "source-1",
          sourceType: "authorized_wiki_document",
          sourceUri: "https://docs.feishu.cn/docx/doc_token_1",
          title: "Handbook",
          authorizedSpaceId: "space-1",
          permissionState: "unknown",
          syncState: "pending",
          canUseForAnswering: true,
          canUseForKnowledgeDrafts: true,
          createdAt: "2026-07-03T03:00:00.000Z",
          updatedAt: "2026-07-03T03:00:00.000Z",
          evidence: [],
        },
        {
          id: "user-source-1",
          sourceType: "user_submitted_document",
          sourceUri: "https://docs.feishu.cn/docx/user_doc_token_1",
          title: "User Guide",
          submittedByUserId: "ou_1",
          permissionState: "unknown",
          syncState: "pending",
          canUseForAnswering: true,
          canUseForKnowledgeDrafts: false,
          createdAt: "2026-07-03T03:10:00.000Z",
          updatedAt: "2026-07-03T03:10:00.000Z",
          evidence: [],
        },
      ],
    });
    expect(runtime.sources.list).toHaveBeenCalledWith({ limit: 2 });
  });

  it("lists document sources by source type", async () => {
    const runtime = fakeDocumentSyncRuntime({
      sources: {
        list: vi.fn(async () => [authorizedWikiSource()]),
        get: vi.fn(),
      },
    });
    const app = buildApp({
      createAnswerDraftRuntime: () => undefined,
      createDocumentSyncRuntime: () => runtime,
    });

    const response = await app.inject({
      method: "GET",
      url: "/internal/document-sync/sources?sourceType=authorized_wiki_document",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().sources).toHaveLength(1);
    expect(runtime.sources.list).toHaveBeenCalledWith({
      limit: 20,
      sourceType: "authorized_wiki_document",
    });
  });

  it("rejects source inventory requests with multiple filters", async () => {
    const app = buildApp({
      createAnswerDraftRuntime: () => undefined,
      createDocumentSyncRuntime: () => fakeDocumentSyncRuntime(),
    });

    const response = await app.inject({
      method: "GET",
      url: "/internal/document-sync/sources?sourceType=authorized_wiki_document&groupId=group-1",
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ ok: false, error: "invalid_request" });
  });

  it("rejects invalid source inventory list limits", async () => {
    const app = buildApp({
      createAnswerDraftRuntime: () => undefined,
      createDocumentSyncRuntime: () => fakeDocumentSyncRuntime(),
    });

    const response = await app.inject({
      method: "GET",
      url: "/internal/document-sync/sources?limit=-1",
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ ok: false, error: "invalid_request" });
  });

  it("returns a document source by id", async () => {
    const runtime = fakeDocumentSyncRuntime({
      sources: {
        list: vi.fn(),
        get: vi.fn(async () => authorizedWikiSource()),
      },
    });
    const app = buildApp({
      createAnswerDraftRuntime: () => undefined,
      createDocumentSyncRuntime: () => runtime,
    });

    const response = await app.inject({
      method: "GET",
      url: "/internal/document-sync/sources/source-1",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      source: {
        id: "source-1",
        sourceType: "authorized_wiki_document",
        sourceUri: "https://docs.feishu.cn/docx/doc_token_1",
        title: "Handbook",
        authorizedSpaceId: "space-1",
        permissionState: "unknown",
        syncState: "pending",
        canUseForAnswering: true,
        canUseForKnowledgeDrafts: true,
        createdAt: "2026-07-03T03:00:00.000Z",
        updatedAt: "2026-07-03T03:00:00.000Z",
        evidence: [],
      },
    });
    expect(runtime.sources.get).toHaveBeenCalledWith("source-1");
  });

  it("returns 404 for unknown document source ids", async () => {
    const app = buildApp({
      createAnswerDraftRuntime: () => undefined,
      createDocumentSyncRuntime: () => fakeDocumentSyncRuntime(),
    });

    const response = await app.inject({
      method: "GET",
      url: "/internal/document-sync/sources/missing",
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ ok: false, error: "document_source_not_found" });
  });

  it("returns 500 when source inventory lookup fails", async () => {
    const runtime = fakeDocumentSyncRuntime({
      sources: {
        list: vi.fn(async () => {
          throw new Error("database unavailable");
        }),
        get: vi.fn(),
      },
    });
    const app = buildApp({
      createAnswerDraftRuntime: () => undefined,
      createDocumentSyncRuntime: () => runtime,
    });

    const response = await app.inject({
      method: "GET",
      url: "/internal/document-sync/sources",
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ ok: false, error: "document_source_lookup_failed" });
  });
});

describe("document sync dead-letter API", () => {
  it("returns 503 when document sync runtime is unavailable", async () => {
    const app = buildApp({
      createAnswerDraftRuntime: () => undefined,
      createDocumentSyncRuntime: () => undefined,
    });

    const response = await app.inject({
      method: "GET",
      url: "/internal/document-sync/dead-letters",
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ ok: false, error: "document_sync_worker_unavailable" });
  });

  it("lists document sync dead letters", async () => {
    const runtime = fakeDocumentSyncRuntime({
      deadLetters: {
        list: vi.fn(async () => [
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
        replay: vi.fn(),
        delete: vi.fn(),
        replayBatch: vi.fn(),
      },
    });
    const app = buildApp({
      createAnswerDraftRuntime: () => undefined,
      createDocumentSyncRuntime: () => runtime,
    });

    const response = await app.inject({
      method: "GET",
      url: "/internal/document-sync/dead-letters?limit=20",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      deadLetters: [
        {
          id: "dlq-1",
          job: {
            idempotencyKey: "document-sync:source-1",
            documentSourceId: "source-1",
            reason: "discovered_group_document",
            enqueuedAt: "2026-07-03T01:00:00.000Z",
            attempts: 3,
          },
          errorMessage: "runner crashed",
          failedAt: "2026-07-03T02:00:00.000Z",
          replayable: true,
        },
      ],
    });
    expect(runtime.deadLetters.list).toHaveBeenCalledWith({ limit: 20 });
  });

  it("rejects invalid document sync dead-letter list limits", async () => {
    const app = buildApp({
      createAnswerDraftRuntime: () => undefined,
      createDocumentSyncRuntime: () => fakeDocumentSyncRuntime(),
    });

    const response = await app.inject({
      method: "GET",
      url: "/internal/document-sync/dead-letters?limit=-1",
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ ok: false, error: "invalid_request" });
  });

  it("replays a document sync dead letter", async () => {
    const runtime = fakeDocumentSyncRuntime({
      deadLetters: {
        list: vi.fn(),
        replay: vi.fn(async () => "replayed" as const),
        delete: vi.fn(),
        replayBatch: vi.fn(),
      },
    });
    const app = buildApp({
      createAnswerDraftRuntime: () => undefined,
      createDocumentSyncRuntime: () => runtime,
    });

    const response = await app.inject({
      method: "POST",
      url: "/internal/document-sync/dead-letters/dlq-1/replay",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, status: "replayed" });
    expect(runtime.deadLetters.replay).toHaveBeenCalledWith("dlq-1");
  });

  it("deletes a document sync dead letter", async () => {
    const runtime = fakeDocumentSyncRuntime({
      deadLetters: {
        list: vi.fn(),
        replay: vi.fn(),
        delete: vi.fn(async () => "deleted" as const),
        replayBatch: vi.fn(),
      },
    });
    const app = buildApp({
      createAnswerDraftRuntime: () => undefined,
      createDocumentSyncRuntime: () => runtime,
    });

    const response = await app.inject({
      method: "DELETE",
      url: "/internal/document-sync/dead-letters/dlq-1",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, status: "deleted" });
    expect(runtime.deadLetters.delete).toHaveBeenCalledWith("dlq-1");
  });

  it("batch replays document sync dead letters", async () => {
    const runtime = fakeDocumentSyncRuntime({
      deadLetters: {
        list: vi.fn(),
        replay: vi.fn(),
        delete: vi.fn(),
        replayBatch: vi.fn(async () => ({
          replayedCount: 1,
          notFoundIds: ["missing"],
          unsupportedLegacyIds: ["legacy:0:abc"],
        })),
      },
    });
    const app = buildApp({
      createAnswerDraftRuntime: () => undefined,
      createDocumentSyncRuntime: () => runtime,
    });

    const response = await app.inject({
      method: "POST",
      url: "/internal/document-sync/dead-letters/replay",
      payload: { ids: ["dlq-1", "missing", "legacy:0:abc"] },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      replayedCount: 1,
      notFoundIds: ["missing"],
      unsupportedLegacyIds: ["legacy:0:abc"],
    });
    expect(runtime.deadLetters.replayBatch).toHaveBeenCalledWith({
      ids: ["dlq-1", "missing", "legacy:0:abc"],
    });
  });

  it("rejects invalid document sync batch replay requests", async () => {
    const app = buildApp({
      createAnswerDraftRuntime: () => undefined,
      createDocumentSyncRuntime: () => fakeDocumentSyncRuntime(),
    });

    const response = await app.inject({
      method: "POST",
      url: "/internal/document-sync/dead-letters/replay",
      payload: { ids: [] },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ ok: false, error: "invalid_request" });
  });

  it("returns 500 when document sync dead-letter operations fail", async () => {
    const runtime = fakeDocumentSyncRuntime({
      deadLetters: {
        list: vi.fn(async () => {
          throw new Error("redis unavailable");
        }),
        replay: vi.fn(),
        delete: vi.fn(),
        replayBatch: vi.fn(),
      },
    });
    const app = buildApp({
      createAnswerDraftRuntime: () => undefined,
      createDocumentSyncRuntime: () => runtime,
    });

    const response = await app.inject({
      method: "GET",
      url: "/internal/document-sync/dead-letters",
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      ok: false,
      error: "document_sync_dead_letter_operation_failed",
    });
  });
});

describe("document sync manual enqueue API", () => {
  it("returns 503 when document sync runtime is unavailable", async () => {
    const app = buildApp({
      createAnswerDraftRuntime: () => undefined,
      createDocumentSyncRuntime: () => undefined,
    });

    const response = await app.inject({
      method: "POST",
      url: "/internal/document-sync/sources/source-1/enqueue",
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ ok: false, error: "document_sync_worker_unavailable" });
  });

  it("enqueues a document source for manual sync", async () => {
    const runtime = fakeDocumentSyncRuntime({
      enqueueSource: vi.fn(async () => ({
        status: "enqueued" as const,
        documentSourceId: "source-1",
      })),
    });
    const app = buildApp({
      createAnswerDraftRuntime: () => undefined,
      createDocumentSyncRuntime: () => runtime,
    });

    const response = await app.inject({
      method: "POST",
      url: "/internal/document-sync/sources/source-1/enqueue",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      status: "enqueued",
      documentSourceId: "source-1",
    });
    expect(runtime.enqueueSource).toHaveBeenCalledWith({ documentSourceId: "source-1" });
  });

  it("returns not_found when manually enqueueing an unknown source", async () => {
    const runtime = fakeDocumentSyncRuntime({
      enqueueSource: vi.fn(async () => ({
        status: "not_found" as const,
        documentSourceId: "missing",
      })),
    });
    const app = buildApp({
      createAnswerDraftRuntime: () => undefined,
      createDocumentSyncRuntime: () => runtime,
    });

    const response = await app.inject({
      method: "POST",
      url: "/internal/document-sync/sources/missing/enqueue",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      status: "not_found",
      documentSourceId: "missing",
    });
  });

  it("rejects blank manual enqueue source ids", async () => {
    const app = buildApp({
      createAnswerDraftRuntime: () => undefined,
      createDocumentSyncRuntime: () => fakeDocumentSyncRuntime(),
    });

    const response = await app.inject({
      method: "POST",
      url: "/internal/document-sync/sources/%20/enqueue",
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ ok: false, error: "invalid_request" });
  });

  it("returns 500 when manual enqueue fails", async () => {
    const runtime = fakeDocumentSyncRuntime({
      enqueueSource: vi.fn(async () => {
        throw new Error("redis unavailable");
      }),
    });
    const app = buildApp({
      createAnswerDraftRuntime: () => undefined,
      createDocumentSyncRuntime: () => runtime,
    });

    const response = await app.inject({
      method: "POST",
      url: "/internal/document-sync/sources/source-1/enqueue",
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ ok: false, error: "document_sync_enqueue_failed" });
  });
});

describe("authorized wiki document registration API", () => {
  it("returns 503 when document sync runtime is unavailable", async () => {
    const app = buildApp({
      createAnswerDraftRuntime: () => undefined,
      createDocumentSyncRuntime: () => undefined,
    });

    const response = await app.inject({
      method: "POST",
      url: "/internal/document-sync/authorized-wiki-documents",
      payload: {
        sourceUri: "https://docs.feishu.cn/docx/doc_token_1",
        authorizedSpaceId: "space-1",
      },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ ok: false, error: "document_sync_worker_unavailable" });
  });

  it("registers an authorized wiki document and enqueues sync", async () => {
    const runtime = fakeDocumentSyncRuntime({
      registerAuthorizedWikiDocument: vi.fn(async () => ({
        source: authorizedWikiSource(),
        enqueue: {
          status: "enqueued" as const,
          documentSourceId: "source-1",
        },
      })),
    });
    const app = buildApp({
      createAnswerDraftRuntime: () => undefined,
      createDocumentSyncRuntime: () => runtime,
    });

    const response = await app.inject({
      method: "POST",
      url: "/internal/document-sync/authorized-wiki-documents",
      payload: {
        sourceUri: " https://docs.feishu.cn/docx/doc_token_1 ",
        title: " Handbook ",
        authorizedSpaceId: " space-1 ",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      source: {
        id: "source-1",
        sourceType: "authorized_wiki_document",
        sourceUri: "https://docs.feishu.cn/docx/doc_token_1",
        title: "Handbook",
        authorizedSpaceId: "space-1",
        permissionState: "unknown",
        syncState: "pending",
        canUseForAnswering: true,
        canUseForKnowledgeDrafts: true,
        createdAt: "2026-07-03T03:00:00.000Z",
        updatedAt: "2026-07-03T03:00:00.000Z",
        evidence: [],
      },
      enqueue: {
        status: "enqueued",
        documentSourceId: "source-1",
      },
    });
    expect(runtime.registerAuthorizedWikiDocument).toHaveBeenCalledWith({
      sourceUri: "https://docs.feishu.cn/docx/doc_token_1",
      title: "Handbook",
      authorizedSpaceId: "space-1",
      observedAt: expect.any(Date),
    });
  });

  it("rejects invalid authorized wiki document requests", async () => {
    const app = buildApp({
      createAnswerDraftRuntime: () => undefined,
      createDocumentSyncRuntime: () => fakeDocumentSyncRuntime(),
    });

    const response = await app.inject({
      method: "POST",
      url: "/internal/document-sync/authorized-wiki-documents",
      payload: {
        sourceUri: " ",
        authorizedSpaceId: "space-1",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ ok: false, error: "invalid_request" });
  });

  it("returns 500 when authorized wiki registration fails", async () => {
    const runtime = fakeDocumentSyncRuntime({
      registerAuthorizedWikiDocument: vi.fn(async () => {
        throw new Error("database unavailable");
      }),
    });
    const app = buildApp({
      createAnswerDraftRuntime: () => undefined,
      createDocumentSyncRuntime: () => runtime,
    });

    const response = await app.inject({
      method: "POST",
      url: "/internal/document-sync/authorized-wiki-documents",
      payload: {
        sourceUri: "https://docs.feishu.cn/docx/doc_token_1",
        authorizedSpaceId: "space-1",
      },
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      ok: false,
      error: "authorized_wiki_document_registration_failed",
    });
  });
});

describe("user submitted document registration API", () => {
  it("returns 503 when document sync runtime is unavailable", async () => {
    const app = buildApp({
      createAnswerDraftRuntime: () => undefined,
      createDocumentSyncRuntime: () => undefined,
    });

    const response = await app.inject({
      method: "POST",
      url: "/internal/document-sync/user-submitted-documents",
      payload: {
        sourceUri: "https://docs.feishu.cn/docx/user_doc_token_1",
        submittedByUserId: "ou_1",
      },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ ok: false, error: "document_sync_worker_unavailable" });
  });

  it("registers a user submitted document and enqueues sync", async () => {
    const runtime = fakeDocumentSyncRuntime({
      registerUserSubmittedDocument: vi.fn(async () => ({
        source: userSubmittedSource(),
        enqueue: {
          status: "enqueued" as const,
          documentSourceId: "user-source-1",
        },
      })),
    });
    const app = buildApp({
      createAnswerDraftRuntime: () => undefined,
      createDocumentSyncRuntime: () => runtime,
    });

    const response = await app.inject({
      method: "POST",
      url: "/internal/document-sync/user-submitted-documents",
      payload: {
        sourceUri: " https://docs.feishu.cn/docx/user_doc_token_1 ",
        title: " User Guide ",
        submittedByUserId: " ou_1 ",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      source: {
        id: "user-source-1",
        sourceType: "user_submitted_document",
        sourceUri: "https://docs.feishu.cn/docx/user_doc_token_1",
        title: "User Guide",
        submittedByUserId: "ou_1",
        permissionState: "unknown",
        syncState: "pending",
        canUseForAnswering: true,
        canUseForKnowledgeDrafts: false,
        createdAt: "2026-07-03T03:10:00.000Z",
        updatedAt: "2026-07-03T03:10:00.000Z",
        evidence: [],
      },
      enqueue: {
        status: "enqueued",
        documentSourceId: "user-source-1",
      },
    });
    expect(runtime.registerUserSubmittedDocument).toHaveBeenCalledWith({
      sourceUri: "https://docs.feishu.cn/docx/user_doc_token_1",
      title: "User Guide",
      submittedByUserId: "ou_1",
      observedAt: expect.any(Date),
    });
  });

  it("rejects invalid user submitted document requests", async () => {
    const app = buildApp({
      createAnswerDraftRuntime: () => undefined,
      createDocumentSyncRuntime: () => fakeDocumentSyncRuntime(),
    });

    const response = await app.inject({
      method: "POST",
      url: "/internal/document-sync/user-submitted-documents",
      payload: {
        sourceUri: "https://docs.feishu.cn/docx/user_doc_token_1",
        submittedByUserId: " ",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ ok: false, error: "invalid_request" });
  });

  it("returns 500 when user submitted registration fails", async () => {
    const runtime = fakeDocumentSyncRuntime({
      registerUserSubmittedDocument: vi.fn(async () => {
        throw new Error("database unavailable");
      }),
    });
    const app = buildApp({
      createAnswerDraftRuntime: () => undefined,
      createDocumentSyncRuntime: () => runtime,
    });

    const response = await app.inject({
      method: "POST",
      url: "/internal/document-sync/user-submitted-documents",
      payload: {
        sourceUri: "https://docs.feishu.cn/docx/user_doc_token_1",
        submittedByUserId: "ou_1",
      },
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      ok: false,
      error: "user_submitted_document_registration_failed",
    });
  });
});

function fakeReindexRuntime(overrides: Partial<ReindexWorkerRuntime> = {}): ReindexWorkerRuntime {
  return {
    activeEmbeddingProfileId: "openai-compatible:text-embedding-small:1536",
    planner: {
      planDocumentProfileReindex: vi.fn(async () => ({
        enqueuedCount: 2,
        skippedCount: 0,
      })),
    },
    getStatus: vi.fn(async () => ({
      enabled: true as const,
      running: true,
      activeEmbeddingProfileId: "openai-compatible:text-embedding-small:1536",
      intervalMs: 1000,
      batchLimit: 25,
      pendingJobCount: 0,
      deadLetterJobCount: 0,
    })),
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
    start: vi.fn(),
    close: vi.fn(async () => undefined),
    ...overrides,
  };
}

function fakeEventRuntime(overrides: Partial<EventWorkerRuntime> = {}): EventWorkerRuntime {
  return {
    getStatus: vi.fn(async () => ({
      enabled: true as const,
      running: true,
      intervalMs: 1000,
      batchLimit: 50,
      pendingEventCount: 0,
      deadLetterEventCount: 0,
    })),
    start: vi.fn(),
    close: vi.fn(async () => undefined),
    ...overrides,
  };
}

function fakeDocumentSyncRuntime(
  overrides: Partial<DocumentSyncRuntime> = {},
): DocumentSyncRuntime {
  return {
    getStatus: vi.fn(async () => ({
      enabled: true as const,
      running: true,
      intervalMs: 1000,
      batchLimit: 10,
      pendingJobCount: 0,
      deadLetterJobCount: 0,
    })),
    sources: {
      list: vi.fn(async () => []),
      get: vi.fn(async () => undefined),
    },
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
    enqueueSource: vi.fn(async () => ({
      status: "not_found" as const,
      documentSourceId: "missing",
    })),
    registerAuthorizedWikiDocument: vi.fn(async () => ({
      source: authorizedWikiSource(),
      enqueue: {
        status: "enqueued" as const,
        documentSourceId: "source-1",
      },
    })),
    registerUserSubmittedDocument: vi.fn(async () => ({
      source: userSubmittedSource(),
      enqueue: {
        status: "enqueued" as const,
        documentSourceId: "user-source-1",
      },
    })),
    start: vi.fn(),
    close: vi.fn(async () => undefined),
    ...overrides,
  };
}

function authorizedWikiSource() {
  return {
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
}

function userSubmittedSource() {
  return {
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
}
