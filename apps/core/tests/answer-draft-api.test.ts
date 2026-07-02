import { describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
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
    })),
    start: vi.fn(),
    close: vi.fn(async () => undefined),
    ...overrides,
  };
}
