import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AnswerDraftInput } from "../src/agent/answer-draft-orchestrator.js";
import { InMemoryAuditLog } from "../src/audit/audit-log.js";
import { buildApp, type BuildAppDependencies } from "../src/app.js";
import type { RawEvent } from "../src/events/raw-event-queue.js";
import type { DocumentSyncRuntime } from "../src/runtime/document-sync-runtime.js";
import type { EventWorkerRuntime } from "../src/runtime/event-worker-runtime.js";
import type { ReindexWorkerRuntime } from "../src/runtime/reindex-worker-runtime.js";
import { isolateEnvVar } from "./test-env.js";

let restoreInternalApiToken: () => void = () => undefined;

beforeEach(() => {
  restoreInternalApiToken = isolateEnvVar("IRIS_INTERNAL_API_TOKEN");
});

afterEach(() => {
  restoreInternalApiToken();
});

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

  it("passes optional chatId to the answer draft orchestrator", async () => {
    const answerDraftOrchestrator = {
      generateDraft: vi.fn(async () => ({
        answerText: "Draft answer.",
        promptContext: "<live_chat_context></live_chat_context>",
        allowedFragments: [],
        deniedDocumentIds: [],
        retrievedFragmentCount: 0,
      })),
    };
    const app = buildApp({ answerDraftOrchestrator });

    const response = await app.inject({
      method: "POST",
      url: "/internal/answer-drafts",
      payload: {
        question: "What changed?",
        chatId: " oc_1 ",
        liveChatMessages: [],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(answerDraftOrchestrator.generateDraft).toHaveBeenCalledWith({
      question: "What changed?",
      chatId: "oc_1",
      liveChatMessages: [],
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

  it("returns 400 when chatId is provided as blank", async () => {
    const answerDraftOrchestrator = { generateDraft: vi.fn() };
    const app = buildApp({ answerDraftOrchestrator });

    const response = await app.inject({
      method: "POST",
      url: "/internal/answer-drafts",
      payload: {
        question: "What changed?",
        chatId: "   ",
        liveChatMessages: [],
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ ok: false, error: "invalid_request" });
    expect(answerDraftOrchestrator.generateDraft).not.toHaveBeenCalled();
  });

  it("returns 400 when chatId is oversized", async () => {
    const answerDraftOrchestrator = { generateDraft: vi.fn() };
    const app = buildApp({ answerDraftOrchestrator });

    const response = await app.inject({
      method: "POST",
      url: "/internal/answer-drafts",
      payload: {
        question: "What changed?",
        chatId: "c".repeat(513),
        liveChatMessages: [],
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ ok: false, error: "invalid_request" });
    expect(answerDraftOrchestrator.generateDraft).not.toHaveBeenCalled();
  });

  it("returns 400 when the question is oversized", async () => {
    const answerDraftOrchestrator = { generateDraft: vi.fn() };
    const app = buildApp({ answerDraftOrchestrator });

    const response = await app.inject({
      method: "POST",
      url: "/internal/answer-drafts",
      payload: {
        question: "q".repeat(4001),
        liveChatMessages: [],
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ ok: false, error: "invalid_request" });
    expect(answerDraftOrchestrator.generateDraft).not.toHaveBeenCalled();
  });

  it("returns 400 when too many live chat messages are supplied", async () => {
    const answerDraftOrchestrator = { generateDraft: vi.fn() };
    const app = buildApp({ answerDraftOrchestrator });

    const response = await app.inject({
      method: "POST",
      url: "/internal/answer-drafts",
      payload: {
        question: "What changed?",
        liveChatMessages: Array.from({ length: 51 }, (_, index) => ({
          speaker: "Alice",
          text: `message-${index + 1}`,
        })),
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ ok: false, error: "invalid_request" });
    expect(answerDraftOrchestrator.generateDraft).not.toHaveBeenCalled();
  });

  it("truncates oversized live chat message fields before calling the orchestrator", async () => {
    const answerDraftOrchestrator = {
      generateDraft: vi.fn(async (_input: AnswerDraftInput) => ({
        answerText: "Draft answer.",
        promptContext: "<live_chat_context></live_chat_context>",
        allowedFragments: [],
        deniedDocumentIds: [],
        retrievedFragmentCount: 0,
      })),
    };
    const app = buildApp({ answerDraftOrchestrator });

    const response = await app.inject({
      method: "POST",
      url: "/internal/answer-drafts",
      payload: {
        question: "What changed?",
        liveChatMessages: [
          {
            speaker: `${"S".repeat(300)} trailing speaker detail`,
            text: `${"T".repeat(2500)} trailing message detail`,
          },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    const request = answerDraftOrchestrator.generateDraft.mock.calls[0]?.[0];
    if (request === undefined) {
      throw new Error("expected generateDraft to be called");
    }
    expect(request.liveChatMessages[0].speaker.length).toBeLessThanOrEqual(256);
    expect(request.liveChatMessages[0].speaker).toContain("[truncated]");
    expect(request.liveChatMessages[0].speaker).not.toContain("trailing speaker detail");
    expect(request.liveChatMessages[0].text.length).toBeLessThanOrEqual(2000);
    expect(request.liveChatMessages[0].text).toContain("[truncated]");
    expect(request.liveChatMessages[0].text).not.toContain("trailing message detail");
  });

  it("returns 400 for unsafe context limits", async () => {
    const answerDraftOrchestrator = { generateDraft: vi.fn() };
    const app = buildApp({ answerDraftOrchestrator });

    const fragmentLimitResponse = await app.inject({
      method: "POST",
      url: "/internal/answer-drafts",
      payload: {
        question: "What changed?",
        liveChatMessages: [],
        fragmentLimit: 9007199254740992,
      },
    });
    const liveChatLimitResponse = await app.inject({
      method: "POST",
      url: "/internal/answer-drafts",
      payload: {
        question: "What changed?",
        liveChatMessages: [],
        liveChatLimit: 9007199254740992,
      },
    });

    expect(fragmentLimitResponse.statusCode).toBe(400);
    expect(fragmentLimitResponse.json()).toEqual({ ok: false, error: "invalid_request" });
    expect(liveChatLimitResponse.statusCode).toBe(400);
    expect(liveChatLimitResponse.json()).toEqual({ ok: false, error: "invalid_request" });
    expect(answerDraftOrchestrator.generateDraft).not.toHaveBeenCalled();
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

  it("passes the shared audit log into the composed answer draft runtime", async () => {
    const auditLog = new InMemoryAuditLog();
    const createAnswerDraftRuntime = vi.fn(() => ({
      answerDraftOrchestrator: {
        generateDraft: vi.fn(async () => ({
          answerText: "Runtime draft",
          promptContext: "",
          allowedFragments: [],
          deniedDocumentIds: [],
          retrievedFragmentCount: 0,
        })),
      },
      close: vi.fn(async () => undefined),
    }));

    buildApp({ auditLog, createAnswerDraftRuntime });

    expect(createAnswerDraftRuntime).toHaveBeenCalledWith({
      dependencies: { auditLog },
      runtimeController: expect.any(Object),
    });
  });

  it("passes the active answer draft orchestrator into the event worker runtime", async () => {
    const answerDraftOrchestrator = {
      generateDraft: vi.fn(async () => ({
        answerText: "Runtime draft",
        promptContext: "",
        allowedFragments: [],
        deniedDocumentIds: [],
        retrievedFragmentCount: 0,
      })),
    };
    const createEventWorkerRuntimeMock = vi.fn();
    const createEventWorkerRuntime: NonNullable<
      BuildAppDependencies["createEventWorkerRuntime"]
    > = (input) => {
      createEventWorkerRuntimeMock(input);
      expect(input?.answerDraftOrchestrator).toBe(answerDraftOrchestrator);
      return undefined;
    };

    buildApp({
      answerDraftOrchestrator,
      createEventWorkerRuntime,
    });

    expect(createEventWorkerRuntimeMock).toHaveBeenCalledWith({
      runtimeController: expect.any(Object),
      answerDraftOrchestrator,
    });
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

  it("attempts to close every runtime when one runtime close fails", async () => {
    const closeError = new Error("document sync close failed");
    const answerDraftRuntime = {
      answerDraftOrchestrator: {
        generateDraft: vi.fn(async () => ({
          answerText: "Runtime draft",
          promptContext: "",
          allowedFragments: [],
          deniedDocumentIds: [],
          retrievedFragmentCount: 0,
        })),
      },
      close: vi.fn(async () => undefined),
    };
    const eventWorkerRuntime = fakeEventRuntime();
    const reindexWorkerRuntime = fakeReindexRuntime();
    const documentSyncRuntime = fakeDocumentSyncRuntime({
      close: vi.fn(async () => {
        throw closeError;
      }),
    });
    const app = buildApp({
      createAnswerDraftRuntime: () => answerDraftRuntime,
      createEventWorkerRuntime: () => eventWorkerRuntime,
      createReindexWorkerRuntime: () => reindexWorkerRuntime,
      createDocumentSyncRuntime: () => documentSyncRuntime,
    });

    await expect(app.close()).rejects.toThrow("document sync close failed");

    expect(documentSyncRuntime.close).toHaveBeenCalledOnce();
    expect(eventWorkerRuntime.close).toHaveBeenCalledOnce();
    expect(reindexWorkerRuntime.close).toHaveBeenCalledOnce();
    expect(answerDraftRuntime.close).toHaveBeenCalledOnce();
  });
});

describe("internal API token guard", () => {
  it("requires the configured bearer token for internal routes only", async () => {
    const app = buildApp({
      internalApiToken: "operator-secret",
      createAnswerDraftRuntime: () => undefined,
      createEventWorkerRuntime: () => undefined,
      createDocumentSyncRuntime: () => undefined,
      createReindexWorkerRuntime: () => undefined,
    });

    const missingTokenResponse = await app.inject({
      method: "GET",
      url: "/internal/status",
    });
    const wrongTokenResponse = await app.inject({
      method: "GET",
      url: "/internal/status",
      headers: { authorization: "Bearer wrong-secret" },
    });
    const authorizedResponse = await app.inject({
      method: "GET",
      url: "/internal/status",
      headers: { authorization: "Bearer operator-secret" },
    });
    const healthResponse = await app.inject({
      method: "GET",
      url: "/health",
    });

    expect(missingTokenResponse.statusCode).toBe(401);
    expect(missingTokenResponse.json()).toEqual({
      ok: false,
      error: "internal_api_unauthorized",
    });
    expect(wrongTokenResponse.statusCode).toBe(401);
    expect(wrongTokenResponse.json()).toEqual({
      ok: false,
      error: "internal_api_unauthorized",
    });
    expect(authorizedResponse.statusCode).toBe(200);
    expect(authorizedResponse.json().schemaVersion).toBe(1);
    expect(healthResponse.statusCode).toBe(200);
    expect(healthResponse.json()).toEqual({ ok: true, service: "iris-core" });
  });

  it("rejects unauthorized internal requests before parsing JSON bodies", async () => {
    const app = buildApp({
      internalApiToken: "operator-secret",
      createAnswerDraftRuntime: () => undefined,
      createEventWorkerRuntime: () => undefined,
      createDocumentSyncRuntime: () => undefined,
      createReindexWorkerRuntime: () => undefined,
    });

    const response = await app.inject({
      method: "POST",
      url: "/internal/runtime-control/global",
      headers: { "content-type": "application/json" },
      payload: "{not-json",
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      ok: false,
      error: "internal_api_unauthorized",
    });
  });

  it("guards internal root probes when a query string is present", async () => {
    const app = buildApp({
      internalApiToken: "operator-secret",
      createAnswerDraftRuntime: () => undefined,
      createEventWorkerRuntime: () => undefined,
      createDocumentSyncRuntime: () => undefined,
      createReindexWorkerRuntime: () => undefined,
    });

    const response = await app.inject({
      method: "GET",
      url: "/internal?probe=1",
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      ok: false,
      error: "internal_api_unauthorized",
    });
  });

  it("accepts bearer authorization scheme case-insensitively", async () => {
    const app = buildApp({
      internalApiToken: "operator-secret",
      createAnswerDraftRuntime: () => undefined,
      createEventWorkerRuntime: () => undefined,
      createDocumentSyncRuntime: () => undefined,
      createReindexWorkerRuntime: () => undefined,
    });

    const response = await app.inject({
      method: "GET",
      url: "/internal/status",
      headers: { authorization: "bearer operator-secret" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().schemaVersion).toBe(1);
  });

  it("rejects malformed bearer credentials for internal routes", async () => {
    const app = buildApp({
      internalApiToken: "operator-secret",
      createAnswerDraftRuntime: () => undefined,
      createEventWorkerRuntime: () => undefined,
      createDocumentSyncRuntime: () => undefined,
      createReindexWorkerRuntime: () => undefined,
    });

    const tabSeparatedResponse = await app.inject({
      method: "GET",
      url: "/internal/status",
      headers: { authorization: "Bearer\toperator-secret" },
    });
    const combinedCredentialResponse = await app.inject({
      method: "GET",
      url: "/internal/status",
      headers: { authorization: "Bearer operator-secret, Bearer other-secret" },
    });

    expect(tabSeparatedResponse.statusCode).toBe(401);
    expect(tabSeparatedResponse.json()).toEqual({
      ok: false,
      error: "internal_api_unauthorized",
    });
    expect(combinedCredentialResponse.statusCode).toBe(401);
    expect(combinedCredentialResponse.json()).toEqual({
      ok: false,
      error: "internal_api_unauthorized",
    });
  });

  it("rejects configured internal API tokens that cannot be sent as one bearer credential", () => {
    const invalidTokens = ["operator secret", "operator\tsecret", "operator,secret"];

    for (const internalApiToken of invalidTokens) {
      expect(() =>
        buildApp({
          internalApiToken,
          createAnswerDraftRuntime: () => undefined,
          createEventWorkerRuntime: () => undefined,
          createDocumentSyncRuntime: () => undefined,
          createReindexWorkerRuntime: () => undefined,
        }),
      ).toThrow("IRIS_INTERNAL_API_TOKEN must be a single bearer token");
    }
  });
});

describe("GET /internal/audit/status", () => {
  it("returns in-memory audit log retention status", async () => {
    const auditLog = new InMemoryAuditLog({ maxEvents: 2 });
    await auditLog.record({
      type: "permission_guard_denied",
      documentId: "source-1",
      fragmentIds: ["fragment-1"],
    });
    await auditLog.record({
      type: "permission_guard_denied",
      documentId: "source-2",
      fragmentIds: ["fragment-2"],
    });
    await auditLog.record({
      type: "permission_guard_denied",
      documentId: "source-3",
      fragmentIds: ["fragment-3"],
    });
    const app = buildApp({
      auditLog,
      createAnswerDraftRuntime: () => undefined,
    });

    const response = await app.inject({
      method: "GET",
      url: "/internal/audit/status",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      enabled: true,
      storage: "in_memory",
      retention: {
        maxEventCount: 2,
        retainedEventCount: 2,
        droppedEventCount: 1,
      },
    });
  });
});

describe("GET /internal/status", () => {
  it("returns a consolidated internal service status snapshot", async () => {
    const auditLog = new InMemoryAuditLog({ maxEvents: 2 });
    const generatedAt = new Date("2026-07-03T07:30:00.000Z");
    await auditLog.record({
      type: "permission_guard_denied",
      documentId: "source-1",
      fragmentIds: ["fragment-1"],
    });
    const eventWorkerRuntime = fakeEventRuntime({
      getStatus: vi.fn(async () => ({
        enabled: true as const,
        running: true,
        intervalMs: 1000,
        batchLimit: 50,
        mentionRepliesEnabled: false,
        mentionRepliesUnavailableReason: "missing_bot_open_id" as const,
        pendingEventCount: 3,
        deadLetterEventCount: 1,
      })),
    });
    const documentSyncRuntime = fakeDocumentSyncRuntime({
      getStatus: vi.fn(async () => ({
        enabled: true as const,
        running: true,
        intervalMs: 2000,
        batchLimit: 10,
        pendingJobCount: 4,
        deadLetterJobCount: 2,
      })),
    });
    const reindexWorkerRuntime = fakeReindexRuntime({
      getStatus: vi.fn(async () => ({
        enabled: true as const,
        running: false,
        activeEmbeddingProfileId: "openai-compatible:text-embedding-small:1536",
        intervalMs: 3000,
        batchLimit: 25,
        pendingJobCount: 5,
        deadLetterJobCount: 0,
      })),
    });
    const app = buildApp({
      auditLog,
      now: () => generatedAt,
      createAnswerDraftRuntime: () => undefined,
      createEventWorkerRuntime: () => eventWorkerRuntime,
      createDocumentSyncRuntime: () => documentSyncRuntime,
      createReindexWorkerRuntime: () => reindexWorkerRuntime,
    });

    const response = await app.inject({
      method: "GET",
      url: "/internal/status",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: false,
      status: "degraded",
      schemaVersion: 1,
      generatedAt: "2026-07-03T07:30:00.000Z",
      componentOrder: [
        "audit",
        "runtimeControl",
        "answerDraft",
        "feishuGateway",
        "eventWorker",
        "documentSync",
        "reindex",
      ],
      summary: {
        componentCount: 7,
        healthyComponentCount: 5,
        degradedComponentCount: 2,
        degradedComponents: ["eventWorker", "documentSync"],
        enabledComponentCount: 6,
        disabledComponentCount: 1,
        disabledComponents: ["answerDraft"],
        enabledRuntimeComponentCount: 3,
        runningEnabledRuntimeComponentCount: 2,
        stoppedEnabledRuntimeComponentCount: 1,
        stoppedEnabledRuntimeComponents: ["reindex"],
        componentStatusCounts: {
          healthy: 3,
          disabled: 1,
          degraded: 2,
          stopped: 1,
        },
        attentionComponents: [
          { name: "eventWorker", status: "degraded" },
          { name: "documentSync", status: "degraded" },
          { name: "reindex", status: "stopped" },
          { name: "answerDraft", status: "disabled" },
        ],
        attentionComponentCount: 4,
        requiresOperatorAttention: true,
        primaryAttentionComponent: { name: "eventWorker", status: "degraded" },
        attentionSeverity: "critical",
      },
      components: {
        audit: {
          status: "healthy",
          ok: true,
          enabled: true,
          storage: "in_memory",
          retention: {
            maxEventCount: 2,
            retainedEventCount: 1,
            droppedEventCount: 0,
          },
        },
        runtimeControl: {
          status: "healthy",
          ok: true,
          enabled: true,
          globalEnabled: true,
          disabledGroupIds: [],
          disabledGroupCount: 0,
          capabilities: {
            readGroupContext: true,
            replyWhenMentioned: true,
            readGroupDocuments: true,
            retrieveKnowledgeBase: true,
            proactiveSpeech: true,
            generateKnowledgeDrafts: true,
            writeKnowledgeBase: false,
            callExternalTools: false,
          },
        },
        answerDraft: {
          status: "disabled",
          ok: true,
          enabled: false,
        },
        feishuGateway: {
          status: "healthy",
          ok: true,
          enabled: true,
          enqueueFailureCount: 0,
        },
        eventWorker: {
          status: "degraded",
          ok: false,
          enabled: true,
          running: true,
          intervalMs: 1000,
          batchLimit: 50,
          mentionRepliesEnabled: false,
          mentionRepliesUnavailableReason: "missing_bot_open_id",
          pendingEventCount: 3,
          deadLetterEventCount: 1,
          degradedReason: "dead_letters_present",
        },
        documentSync: {
          status: "degraded",
          ok: false,
          enabled: true,
          running: true,
          intervalMs: 2000,
          batchLimit: 10,
          pendingJobCount: 4,
          deadLetterJobCount: 2,
          degradedReason: "dead_letters_present",
        },
        reindex: {
          status: "stopped",
          ok: true,
          enabled: true,
          running: false,
          activeEmbeddingProfileId: "openai-compatible:text-embedding-small:1536",
          intervalMs: 3000,
          batchLimit: 25,
          pendingJobCount: 5,
          deadLetterJobCount: 0,
        },
      },
    });
  });

  it("marks reindex as degraded in the consolidated status when its DLQ is non-empty", async () => {
    const reindexWorkerRuntime = fakeReindexRuntime({
      getStatus: vi.fn(async () => ({
        enabled: true as const,
        running: true,
        activeEmbeddingProfileId: "openai-compatible:text-embedding-small:1536",
        intervalMs: 3000,
        batchLimit: 25,
        pendingJobCount: 0,
        deadLetterJobCount: 3,
      })),
    });
    const app = buildApp({
      createAnswerDraftRuntime: () => undefined,
      createEventWorkerRuntime: () => undefined,
      createDocumentSyncRuntime: () => undefined,
      createReindexWorkerRuntime: () => reindexWorkerRuntime,
    });

    const response = await app.inject({
      method: "GET",
      url: "/internal/status",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().components.reindex).toEqual({
      status: "degraded",
      ok: false,
      enabled: true,
      running: true,
      activeEmbeddingProfileId: "openai-compatible:text-embedding-small:1536",
      intervalMs: 3000,
      batchLimit: 25,
      pendingJobCount: 0,
      deadLetterJobCount: 3,
      degradedReason: "dead_letters_present",
    });
    expect(response.json().summary.primaryAttentionComponent).toEqual({
      name: "reindex",
      status: "degraded",
    });
    expect(response.json().summary.attentionSeverity).toBe("critical");
  });

  it("keeps the consolidated status available when one component status fails", async () => {
    const eventWorkerRuntime = fakeEventRuntime({
      getStatus: vi.fn(async () => {
        throw new Error("redis unavailable");
      }),
    });
    const documentSyncRuntime = fakeDocumentSyncRuntime({
      getStatus: vi.fn(async () => ({
        enabled: true as const,
        running: true,
        intervalMs: 2000,
        batchLimit: 10,
        pendingJobCount: 4,
        deadLetterJobCount: 2,
      })),
    });
    const app = buildApp({
      createAnswerDraftRuntime: () => undefined,
      createEventWorkerRuntime: () => eventWorkerRuntime,
      createDocumentSyncRuntime: () => documentSyncRuntime,
      createReindexWorkerRuntime: () => undefined,
    });

    const response = await app.inject({
      method: "GET",
      url: "/internal/status",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().ok).toBe(false);
    expect(response.json().status).toBe("degraded");
    expect(response.json().summary).toEqual({
      componentCount: 7,
      healthyComponentCount: 5,
      degradedComponentCount: 2,
      degradedComponents: ["eventWorker", "documentSync"],
      enabledComponentCount: 5,
      disabledComponentCount: 2,
      disabledComponents: ["answerDraft", "reindex"],
      enabledRuntimeComponentCount: 2,
      runningEnabledRuntimeComponentCount: 1,
      stoppedEnabledRuntimeComponentCount: 1,
      stoppedEnabledRuntimeComponents: ["eventWorker"],
      componentStatusCounts: {
        healthy: 3,
        disabled: 2,
        degraded: 2,
        stopped: 0,
      },
      attentionComponents: [
        { name: "eventWorker", status: "degraded" },
        { name: "documentSync", status: "degraded" },
        { name: "answerDraft", status: "disabled" },
        { name: "reindex", status: "disabled" },
      ],
      attentionComponentCount: 4,
      requiresOperatorAttention: true,
      primaryAttentionComponent: { name: "eventWorker", status: "degraded" },
      attentionSeverity: "critical",
    });
    expect(response.json().components.eventWorker).toEqual({
      status: "degraded",
      ok: false,
      enabled: true,
      running: false,
      error: "event_worker_status_failed",
    });
    expect(response.json().components.documentSync).toEqual({
      status: "degraded",
      ok: false,
      enabled: true,
      running: true,
      intervalMs: 2000,
      batchLimit: 10,
      pendingJobCount: 4,
      deadLetterJobCount: 2,
      degradedReason: "dead_letters_present",
    });
    expect(response.json().components.reindex).toEqual({
      status: "disabled",
      ok: true,
      enabled: false,
      running: false,
    });
  });

  it("surfaces Feishu gateway enqueue failures in the consolidated status", async () => {
    const generatedAt = new Date("2026-07-03T09:00:00.000Z");
    const rawEventQueue = {
      enqueue: vi.fn(async () => {
        throw new Error("redis unavailable");
      }),
    };
    const app = buildApp({
      rawEventQueue,
      now: () => generatedAt,
      createAnswerDraftRuntime: () => undefined,
      createEventWorkerRuntime: () => undefined,
      createDocumentSyncRuntime: () => undefined,
      createReindexWorkerRuntime: () => undefined,
    });

    const callbackResponse = await app.inject({
      method: "POST",
      url: "/feishu/events",
      payload: {
        header: {
          event_id: "event-gateway-enqueue-failure",
          event_type: "im.message.receive_v1",
        },
      },
    });
    await Promise.resolve();

    const statusResponse = await app.inject({
      method: "GET",
      url: "/internal/status",
    });

    expect(callbackResponse.statusCode).toBe(200);
    expect(statusResponse.statusCode).toBe(200);
    expect(statusResponse.json().components.feishuGateway).toEqual({
      status: "degraded",
      ok: false,
      enabled: true,
      enqueueFailureCount: 1,
      degradedReason: "enqueue_failures_present",
      latestEnqueueError: {
        message: "redis unavailable",
        recordedAt: "2026-07-03T09:00:00.000Z",
      },
    });
    expect(statusResponse.json().summary.degradedComponents).toContain("feishuGateway");
    expect(statusResponse.json().summary.primaryAttentionComponent).toEqual({
      name: "feishuGateway",
      status: "degraded",
    });
    expect(statusResponse.json().summary.attentionSeverity).toBe("critical");
  });

  it("bounds Feishu gateway enqueue failure messages in the consolidated status", async () => {
    const generatedAt = new Date("2026-07-03T09:05:00.000Z");
    const oversizedMessage = `${"E".repeat(1200)} trailing diagnostic detail`;
    const rawEventQueue = {
      enqueue: vi.fn(async () => {
        throw new Error(oversizedMessage);
      }),
    };
    const app = buildApp({
      rawEventQueue,
      now: () => generatedAt,
      createAnswerDraftRuntime: () => undefined,
      createEventWorkerRuntime: () => undefined,
      createDocumentSyncRuntime: () => undefined,
      createReindexWorkerRuntime: () => undefined,
    });

    await app.inject({
      method: "POST",
      url: "/feishu/events",
      payload: {
        header: {
          event_id: "event-gateway-oversized-enqueue-failure",
          event_type: "im.message.receive_v1",
        },
      },
    });
    await Promise.resolve();

    const statusResponse = await app.inject({
      method: "GET",
      url: "/internal/status",
    });

    const message = statusResponse.json().components.feishuGateway.latestEnqueueError.message;
    expect(statusResponse.statusCode).toBe(200);
    expect(message.length).toBeLessThanOrEqual(1000);
    expect(message).toContain("[truncated]");
    expect(message).not.toContain("trailing diagnostic detail");
  });
});

describe("GET /internal/audit/events", () => {
  it("returns recent audit events newest first with a limit", async () => {
    const recordedTimes = [
      new Date("2026-07-03T06:00:00.000Z"),
      new Date("2026-07-03T06:01:00.000Z"),
      new Date("2026-07-03T06:02:00.000Z"),
    ];
    let nowIndex = 0;
    const auditLog = new InMemoryAuditLog({
      now: () => recordedTimes[nowIndex++] ?? recordedTimes.at(-1)!,
    });
    await auditLog.record({
      type: "permission_guard_denied",
      documentId: "source-old",
      fragmentIds: ["fragment-old"],
    });
    await auditLog.record({
      type: "permission_guard_denied",
      documentId: "source-middle",
      fragmentIds: ["fragment-middle"],
    });
    await auditLog.record({
      type: "permission_guard_error",
      documentId: "source-new",
      fragmentIds: ["fragment-new"],
      message: "registry unavailable",
    });
    const app = buildApp({
      auditLog,
      createAnswerDraftRuntime: () => undefined,
    });

    const response = await app.inject({
      method: "GET",
      url: "/internal/audit/events?limit=2",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      meta: {
        limit: 2,
        maxEventCount: 1000,
        retainedEventCount: 3,
        droppedEventCount: 0,
        inspectedEventCount: 2,
        matchingEventCount: 2,
        filters: {},
      },
      events: [
        {
          type: "permission_guard_error",
          documentId: "source-new",
          fragmentIds: ["fragment-new"],
          message: "registry unavailable",
          recordedAt: "2026-07-03T06:02:00.000Z",
        },
        {
          type: "permission_guard_denied",
          documentId: "source-middle",
          fragmentIds: ["fragment-middle"],
          recordedAt: "2026-07-03T06:01:00.000Z",
        },
      ],
    });
  });

  it("rejects invalid audit event limits", async () => {
    const app = buildApp({
      createAnswerDraftRuntime: () => undefined,
    });

    const response = await app.inject({
      method: "GET",
      url: "/internal/audit/events?limit=-1",
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ ok: false, error: "invalid_request" });

    const scientificResponse = await app.inject({
      method: "GET",
      url: "/internal/audit/events?limit=1e2",
    });

    expect(scientificResponse.statusCode).toBe(400);
    expect(scientificResponse.json()).toEqual({ ok: false, error: "invalid_request" });
  });

  it("returns no audit events when the limit is zero", async () => {
    const auditLog = new InMemoryAuditLog();
    await auditLog.record({
      type: "permission_guard_denied",
      documentId: "source-1",
      fragmentIds: ["fragment-1"],
    });
    const app = buildApp({
      auditLog,
      createAnswerDraftRuntime: () => undefined,
    });

    const response = await app.inject({
      method: "GET",
      url: "/internal/audit/events?limit=0",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      meta: {
        limit: 0,
        maxEventCount: 1000,
        retainedEventCount: 1,
        droppedEventCount: 0,
        inspectedEventCount: 0,
        matchingEventCount: 0,
        filters: {},
      },
      events: [],
    });
  });

  it("reports audit retention capacity and dropped event count", async () => {
    const auditLog = new InMemoryAuditLog({ maxEvents: 2 });
    await auditLog.record({
      type: "permission_guard_denied",
      documentId: "source-1",
      fragmentIds: ["fragment-1"],
    });
    await auditLog.record({
      type: "permission_guard_denied",
      documentId: "source-2",
      fragmentIds: ["fragment-2"],
    });
    await auditLog.record({
      type: "permission_guard_denied",
      documentId: "source-3",
      fragmentIds: ["fragment-3"],
    });
    const app = buildApp({
      auditLog,
      createAnswerDraftRuntime: () => undefined,
    });

    const response = await app.inject({
      method: "GET",
      url: "/internal/audit/events?limit=20",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().meta).toEqual({
      limit: 20,
      maxEventCount: 2,
      retainedEventCount: 2,
      droppedEventCount: 1,
      inspectedEventCount: 2,
      matchingEventCount: 2,
      filters: {},
    });
  });

  it("filters recent audit events by document and event type", async () => {
    const recordedAt = new Date("2026-07-03T06:05:00.000Z");
    const auditLog = new InMemoryAuditLog({ now: () => recordedAt });
    await auditLog.record({
      type: "permission_guard_denied",
      documentId: "source-1",
      fragmentIds: ["fragment-1"],
    });
    await auditLog.record({
      type: "permission_guard_error",
      documentId: "source-1",
      fragmentIds: ["fragment-2"],
      message: "permission lookup failed",
    });
    await auditLog.record({
      type: "permission_guard_denied",
      documentId: "source-2",
      fragmentIds: ["fragment-3"],
    });
    const app = buildApp({
      auditLog,
      createAnswerDraftRuntime: () => undefined,
    });

    const response = await app.inject({
      method: "GET",
      url: "/internal/audit/events?limit=20&documentId=source-1&type=permission_guard_denied",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      meta: {
        limit: 20,
        maxEventCount: 1000,
        retainedEventCount: 3,
        droppedEventCount: 0,
        inspectedEventCount: 3,
        matchingEventCount: 1,
        filters: {
          documentId: "source-1",
          type: "permission_guard_denied",
        },
      },
      events: [
        {
          type: "permission_guard_denied",
          documentId: "source-1",
          fragmentIds: ["fragment-1"],
          recordedAt: "2026-07-03T06:05:00.000Z",
        },
      ],
    });
  });

  it("rejects invalid audit event filters", async () => {
    const app = buildApp({
      createAnswerDraftRuntime: () => undefined,
    });

    const response = await app.inject({
      method: "GET",
      url: "/internal/audit/events?type=unknown",
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ ok: false, error: "invalid_request" });
  });
});

describe("GET /internal/audit/events/summary", () => {
  it("returns recent audit event summaries newest evidence window first", async () => {
    const recordedTimes = [
      new Date("2026-07-03T06:00:00.000Z"),
      new Date("2026-07-03T06:01:00.000Z"),
      new Date("2026-07-03T06:02:00.000Z"),
      new Date("2026-07-03T06:03:00.000Z"),
    ];
    let nowIndex = 0;
    const auditLog = new InMemoryAuditLog({
      now: () => recordedTimes[nowIndex++] ?? recordedTimes.at(-1)!,
    });
    await auditLog.record({
      type: "permission_guard_denied",
      documentId: "source-old",
      fragmentIds: ["fragment-old"],
    });
    await auditLog.record({
      type: "permission_guard_denied",
      documentId: "source-1",
      fragmentIds: ["fragment-1"],
    });
    await auditLog.record({
      type: "permission_guard_error",
      documentId: "source-2",
      fragmentIds: ["fragment-2"],
      message: "permission lookup failed",
    });
    await auditLog.record({
      type: "permission_guard_denied",
      documentId: "source-1",
      fragmentIds: ["fragment-1", "fragment-3"],
    });
    const app = buildApp({
      auditLog,
      createAnswerDraftRuntime: () => undefined,
    });

    const response = await app.inject({
      method: "GET",
      url: "/internal/audit/events/summary?limit=3",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      meta: {
        limit: 3,
        maxEventCount: 1000,
        retainedEventCount: 4,
        droppedEventCount: 0,
        inspectedEventCount: 3,
        matchingEventCount: 3,
        filters: {},
      },
      summaries: [
        {
          documentId: "source-1",
          type: "permission_guard_denied",
          eventCount: 2,
          affectedFragmentCount: 2,
          firstRecordedAt: "2026-07-03T06:01:00.000Z",
          latestRecordedAt: "2026-07-03T06:03:00.000Z",
        },
        {
          documentId: "source-2",
          type: "permission_guard_error",
          eventCount: 1,
          affectedFragmentCount: 1,
          firstRecordedAt: "2026-07-03T06:02:00.000Z",
          latestRecordedAt: "2026-07-03T06:02:00.000Z",
        },
      ],
    });
  });

  it("rejects invalid audit summary limits", async () => {
    const app = buildApp({
      createAnswerDraftRuntime: () => undefined,
    });

    const response = await app.inject({
      method: "GET",
      url: "/internal/audit/events/summary?limit=-1",
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ ok: false, error: "invalid_request" });
  });

  it("returns no audit summaries when the limit is zero", async () => {
    const auditLog = new InMemoryAuditLog();
    await auditLog.record({
      type: "permission_guard_denied",
      documentId: "source-1",
      fragmentIds: ["fragment-1"],
    });
    const app = buildApp({
      auditLog,
      createAnswerDraftRuntime: () => undefined,
    });

    const response = await app.inject({
      method: "GET",
      url: "/internal/audit/events/summary?limit=0",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      meta: {
        limit: 0,
        maxEventCount: 1000,
        retainedEventCount: 1,
        droppedEventCount: 0,
        inspectedEventCount: 0,
        matchingEventCount: 0,
        filters: {},
      },
      summaries: [],
    });
  });

  it("filters audit event summaries by document and event type", async () => {
    const recordedAt = new Date("2026-07-03T06:04:00.000Z");
    const auditLog = new InMemoryAuditLog({ now: () => recordedAt });
    await auditLog.record({
      type: "permission_guard_denied",
      documentId: "source-1",
      fragmentIds: ["fragment-1"],
    });
    await auditLog.record({
      type: "permission_guard_error",
      documentId: "source-1",
      fragmentIds: ["fragment-2"],
      message: "permission lookup failed",
    });
    await auditLog.record({
      type: "permission_guard_denied",
      documentId: "source-2",
      fragmentIds: ["fragment-3"],
    });
    const app = buildApp({
      auditLog,
      createAnswerDraftRuntime: () => undefined,
    });

    const response = await app.inject({
      method: "GET",
      url: "/internal/audit/events/summary?limit=20&documentId=source-1&type=permission_guard_denied",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      meta: {
        limit: 20,
        maxEventCount: 1000,
        retainedEventCount: 3,
        droppedEventCount: 0,
        inspectedEventCount: 3,
        matchingEventCount: 1,
        filters: {
          documentId: "source-1",
          type: "permission_guard_denied",
        },
      },
      summaries: [
        {
          documentId: "source-1",
          type: "permission_guard_denied",
          eventCount: 1,
          affectedFragmentCount: 1,
          firstRecordedAt: "2026-07-03T06:04:00.000Z",
          latestRecordedAt: "2026-07-03T06:04:00.000Z",
        },
      ],
    });
  });

  it("rejects invalid audit summary filters", async () => {
    const app = buildApp({
      createAnswerDraftRuntime: () => undefined,
    });

    const response = await app.inject({
      method: "GET",
      url: "/internal/audit/events/summary?type=unknown",
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ ok: false, error: "invalid_request" });
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

  it("rejects unsafe integer reindex request limits", async () => {
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
        limit: 9007199254740992,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ ok: false, error: "invalid_request" });
    expect(runtime.planner.planDocumentProfileReindex).not.toHaveBeenCalled();
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

  it("rejects non-decimal dead-letter list limits", async () => {
    const runtime = fakeReindexRuntime();
    const app = buildApp({
      createAnswerDraftRuntime: () => undefined,
      createReindexWorkerRuntime: () => runtime,
    });

    const response = await app.inject({
      method: "GET",
      url: "/internal/reindex/dead-letters?limit=0x10",
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ ok: false, error: "invalid_request" });
    expect(runtime.deadLetters.list).not.toHaveBeenCalled();
  });

  it("rejects unsafe dead-letter list limits", async () => {
    const runtime = fakeReindexRuntime();
    const app = buildApp({
      createAnswerDraftRuntime: () => undefined,
      createReindexWorkerRuntime: () => runtime,
    });

    const response = await app.inject({
      method: "GET",
      url: "/internal/reindex/dead-letters?limit=9007199254740992",
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ ok: false, error: "invalid_request" });
    expect(runtime.deadLetters.list).not.toHaveBeenCalled();
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
      payload: { ids: ["dlq-1", "missing", "dlq-1", "legacy:0:abc", "missing"] },
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
        mentionRepliesEnabled: true,
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
      mentionRepliesEnabled: true,
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

describe("event worker dead-letter API", () => {
  it("returns 503 when event runtime is unavailable", async () => {
    const app = buildApp({
      createAnswerDraftRuntime: () => undefined,
      createReindexWorkerRuntime: () => undefined,
      createEventWorkerRuntime: () => undefined,
    });

    const response = await app.inject({
      method: "GET",
      url: "/internal/events/dead-letters",
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ ok: false, error: "event_worker_unavailable" });
  });

  it("lists event worker dead letters", async () => {
    const runtime = fakeEventRuntime({
      deadLetters: {
        list: vi.fn(async () => [
          {
            id: "dlq-1",
            event: rawEventFixture({ attempts: 3 }),
            errorMessage: "processor failed",
            failedAt: new Date("2026-07-04T01:00:00.000Z"),
            replayable: true,
          },
        ]),
        replay: vi.fn(async () => "not_found" as const),
        delete: vi.fn(async () => "not_found" as const),
        replayBatch: vi.fn(async () => ({
          replayedCount: 0,
          notFoundIds: [],
          unsupportedLegacyIds: [],
        })),
      },
    });
    const app = buildApp({
      createAnswerDraftRuntime: () => undefined,
      createReindexWorkerRuntime: () => undefined,
      createEventWorkerRuntime: () => runtime,
    });

    const response = await app.inject({
      method: "GET",
      url: "/internal/events/dead-letters?limit=20",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      deadLetters: [
        {
          id: "dlq-1",
          event: {
            idempotencyKey: "raw-event:feishu:event-1",
            provider: "feishu",
            eventType: "im.message.receive_v1",
            rawBody: { event_id: "event-1" },
            receivedAt: "2026-07-02T01:00:00.000Z",
            attempts: 3,
          },
          errorMessage: "processor failed",
          failedAt: "2026-07-04T01:00:00.000Z",
          replayable: true,
        },
      ],
    });
    expect(runtime.deadLetters.list).toHaveBeenCalledWith({ limit: 20 });
  });

  it("rejects invalid event dead-letter list limits", async () => {
    const runtime = fakeEventRuntime();
    const app = buildApp({
      createAnswerDraftRuntime: () => undefined,
      createReindexWorkerRuntime: () => undefined,
      createEventWorkerRuntime: () => runtime,
    });

    const response = await app.inject({
      method: "GET",
      url: "/internal/events/dead-letters?limit=-1",
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ ok: false, error: "invalid_request" });
    expect(runtime.deadLetters.list).not.toHaveBeenCalled();
  });

  it("replays and deletes event worker dead letters", async () => {
    const runtime = fakeEventRuntime({
      deadLetters: {
        list: vi.fn(async () => []),
        replay: vi.fn(async () => "replayed" as const),
        delete: vi.fn(async () => "deleted" as const),
        replayBatch: vi.fn(async () => ({
          replayedCount: 0,
          notFoundIds: [],
          unsupportedLegacyIds: [],
        })),
      },
    });
    const app = buildApp({
      createAnswerDraftRuntime: () => undefined,
      createReindexWorkerRuntime: () => undefined,
      createEventWorkerRuntime: () => runtime,
    });

    const replayResponse = await app.inject({
      method: "POST",
      url: "/internal/events/dead-letters/dlq-1/replay",
    });
    const deleteResponse = await app.inject({
      method: "DELETE",
      url: "/internal/events/dead-letters/dlq-1",
    });

    expect(replayResponse.statusCode).toBe(200);
    expect(replayResponse.json()).toEqual({ ok: true, status: "replayed" });
    expect(deleteResponse.statusCode).toBe(200);
    expect(deleteResponse.json()).toEqual({ ok: true, status: "deleted" });
    expect(runtime.deadLetters.replay).toHaveBeenCalledWith("dlq-1");
    expect(runtime.deadLetters.delete).toHaveBeenCalledWith("dlq-1");
  });

  it("batch replays event worker dead letters", async () => {
    const runtime = fakeEventRuntime({
      deadLetters: {
        list: vi.fn(async () => []),
        replay: vi.fn(async () => "not_found" as const),
        delete: vi.fn(async () => "not_found" as const),
        replayBatch: vi.fn(async () => ({
          replayedCount: 1,
          notFoundIds: ["missing"],
          unsupportedLegacyIds: ["legacy:0:abc"],
        })),
      },
    });
    const app = buildApp({
      createAnswerDraftRuntime: () => undefined,
      createReindexWorkerRuntime: () => undefined,
      createEventWorkerRuntime: () => runtime,
    });

    const response = await app.inject({
      method: "POST",
      url: "/internal/events/dead-letters/replay",
      payload: { ids: ["dlq-1", "missing", "dlq-1", "legacy:0:abc", "missing"] },
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

  it("returns 500 when event dead-letter operations fail", async () => {
    const runtime = fakeEventRuntime({
      deadLetters: {
        list: vi.fn(async () => {
          throw new Error("redis unavailable");
        }),
        replay: vi.fn(async () => "not_found" as const),
        delete: vi.fn(async () => "not_found" as const),
        replayBatch: vi.fn(async () => ({
          replayedCount: 0,
          notFoundIds: [],
          unsupportedLegacyIds: [],
        })),
      },
    });
    const app = buildApp({
      createAnswerDraftRuntime: () => undefined,
      createReindexWorkerRuntime: () => undefined,
      createEventWorkerRuntime: () => runtime,
    });

    const response = await app.inject({
      method: "GET",
      url: "/internal/events/dead-letters",
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      ok: false,
      error: "event_dead_letter_operation_failed",
    });
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
        updatePolicy: vi.fn(),
        listSnapshots: vi.fn(),
        getSnapshot: vi.fn(),
        getLatestSnapshot: vi.fn(),
        getLatestSnapshots: vi.fn(),
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

  it("lists document sources with latest snapshot summaries", async () => {
    const runtime = fakeDocumentSyncRuntime({
      sources: {
        list: vi.fn(async () => [authorizedWikiSource(), userSubmittedSource()]),
        get: vi.fn(),
        updatePolicy: vi.fn(),
        listSnapshots: vi.fn(),
        getSnapshot: vi.fn(),
        getLatestSnapshot: vi.fn(),
        getLatestSnapshots: vi.fn(async () => new Map([
          [
            "source-1",
            {
            id: "snapshot-1",
            documentSourceId: "source-1",
            sourceUri: "https://docs.feishu.cn/docx/doc_token_1",
            fetchStatus: "failed" as const,
            bodyText: "Should not leak",
            contentHash: undefined,
            sourceVersion: undefined,
            fetchedAt: new Date("2026-07-03T04:00:00.000Z"),
            errorMessage: "Feishu returned 403",
            createdAt: new Date("2026-07-03T04:00:01.000Z"),
            },
          ],
        ])),
      },
    });
    const app = buildApp({
      createAnswerDraftRuntime: () => undefined,
      createDocumentSyncRuntime: () => runtime,
    });

    const response = await app.inject({
      method: "GET",
      url: "/internal/document-sync/sources?limit=2&includeLatestSnapshot=true",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().sources[0]).toMatchObject({
      id: "source-1",
      latestSnapshot: {
        id: "snapshot-1",
        documentSourceId: "source-1",
        sourceUri: "https://docs.feishu.cn/docx/doc_token_1",
        fetchStatus: "failed",
        fetchedAt: "2026-07-03T04:00:00.000Z",
        errorMessage: "Feishu returned 403",
        createdAt: "2026-07-03T04:00:01.000Z",
        bodyTextLength: 15,
      },
    });
    expect(response.json().sources[0].latestSnapshot).not.toHaveProperty("bodyText");
    expect(response.json().sources[0].latestSnapshot).not.toHaveProperty("bodyTextPreview");
    expect(response.json().sources[0].syncHealth).toEqual({
      status: "failing",
      latestSnapshotId: "snapshot-1",
      lastFetchedAt: "2026-07-03T04:00:00.000Z",
      errorMessage: "Feishu returned 403",
    });
    expect(response.json().sources[1]).not.toHaveProperty("latestSnapshot");
    expect(response.json().sources[1].syncHealth).toEqual({ status: "never_synced" });
    expect(runtime.sources.list).toHaveBeenCalledWith({
      limit: 2,
      includeLatestSnapshot: true,
    });
    expect(runtime.sources.getLatestSnapshots).toHaveBeenCalledWith({
      sourceIds: ["source-1", "user-source-1"],
    });
    expect(runtime.sources.getLatestSnapshot).not.toHaveBeenCalled();
  });

  it("does not fetch latest snapshots for empty source inventory pages", async () => {
    const runtime = fakeDocumentSyncRuntime({
      sources: {
        list: vi.fn(async () => []),
        get: vi.fn(),
        updatePolicy: vi.fn(),
        listSnapshots: vi.fn(),
        getSnapshot: vi.fn(),
        getLatestSnapshot: vi.fn(),
        getLatestSnapshots: vi.fn(),
      },
    });
    const app = buildApp({
      createAnswerDraftRuntime: () => undefined,
      createDocumentSyncRuntime: () => runtime,
    });

    const response = await app.inject({
      method: "GET",
      url: "/internal/document-sync/sources?limit=0&includeLatestSnapshot=true",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, sources: [] });
    expect(runtime.sources.list).toHaveBeenCalledWith({
      limit: 0,
      includeLatestSnapshot: true,
    });
    expect(runtime.sources.getLatestSnapshots).not.toHaveBeenCalled();
  });

  it("lists document sources by source type", async () => {
    const runtime = fakeDocumentSyncRuntime({
      sources: {
        list: vi.fn(async () => [authorizedWikiSource()]),
        get: vi.fn(),
        updatePolicy: vi.fn(),
        listSnapshots: vi.fn(),
        getSnapshot: vi.fn(),
        getLatestSnapshot: vi.fn(),
        getLatestSnapshots: vi.fn(),
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

  it("lists document sources by disabled answering policy", async () => {
    const disabledSource = {
      ...authorizedWikiSource(),
      canUseForAnswering: false,
    };
    const runtime = fakeDocumentSyncRuntime({
      sources: {
        list: vi.fn(async () => [disabledSource]),
        get: vi.fn(),
        updatePolicy: vi.fn(),
        listSnapshots: vi.fn(),
        getSnapshot: vi.fn(),
        getLatestSnapshot: vi.fn(),
        getLatestSnapshots: vi.fn(),
      },
    });
    const app = buildApp({
      createAnswerDraftRuntime: () => undefined,
      createDocumentSyncRuntime: () => runtime,
    });

    const response = await app.inject({
      method: "GET",
      url: "/internal/document-sync/sources?usableForAnswering=false",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().sources).toHaveLength(1);
    expect(response.json().sources[0].canUseForAnswering).toBe(false);
    expect(runtime.sources.list).toHaveBeenCalledWith({
      limit: 20,
      usableForAnswering: false,
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

  it("rejects oversized source inventory filter IDs before runtime lookup", async () => {
    const runtime = fakeDocumentSyncRuntime();
    const app = buildApp({
      createAnswerDraftRuntime: () => undefined,
      createDocumentSyncRuntime: () => runtime,
    });

    const response = await app.inject({
      method: "GET",
      url: `/internal/document-sync/sources?groupId=${"g".repeat(513)}`,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ ok: false, error: "invalid_request" });
    expect(runtime.sources.list).not.toHaveBeenCalled();
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

  it("rejects unsafe source inventory list limits", async () => {
    const runtime = fakeDocumentSyncRuntime();
    const app = buildApp({
      createAnswerDraftRuntime: () => undefined,
      createDocumentSyncRuntime: () => runtime,
    });

    const response = await app.inject({
      method: "GET",
      url: "/internal/document-sync/sources?limit=9007199254740992",
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ ok: false, error: "invalid_request" });
    expect(runtime.sources.list).not.toHaveBeenCalled();
  });

  it("rejects non-decimal source inventory list limits", async () => {
    const runtime = fakeDocumentSyncRuntime();
    const app = buildApp({
      createAnswerDraftRuntime: () => undefined,
      createDocumentSyncRuntime: () => runtime,
    });

    const response = await app.inject({
      method: "GET",
      url: "/internal/document-sync/sources?limit=10.0",
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ ok: false, error: "invalid_request" });
    expect(runtime.sources.list).not.toHaveBeenCalled();
  });

  it("rejects blank source inventory list limits", async () => {
    const app = buildApp({
      createAnswerDraftRuntime: () => undefined,
      createDocumentSyncRuntime: () => fakeDocumentSyncRuntime(),
    });

    const response = await app.inject({
      method: "GET",
      url: "/internal/document-sync/sources?limit=",
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ ok: false, error: "invalid_request" });
  });

  it("treats false source inventory latest snapshot flags as omitted", async () => {
    const runtime = fakeDocumentSyncRuntime({
      sources: {
        list: vi.fn(async () => [authorizedWikiSource()]),
        get: vi.fn(),
        updatePolicy: vi.fn(),
        listSnapshots: vi.fn(),
        getSnapshot: vi.fn(),
        getLatestSnapshot: vi.fn(),
        getLatestSnapshots: vi.fn(),
      },
    });
    const app = buildApp({
      createAnswerDraftRuntime: () => undefined,
      createDocumentSyncRuntime: () => runtime,
    });

    const response = await app.inject({
      method: "GET",
      url: "/internal/document-sync/sources?includeLatestSnapshot=false",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().sources[0]).not.toHaveProperty("latestSnapshot");
    expect(runtime.sources.list).toHaveBeenCalledWith({ limit: 20 });
    expect(runtime.sources.getLatestSnapshots).not.toHaveBeenCalled();
  });

  it("rejects invalid source inventory latest snapshot flags", async () => {
    const app = buildApp({
      createAnswerDraftRuntime: () => undefined,
      createDocumentSyncRuntime: () => fakeDocumentSyncRuntime(),
    });

    const response = await app.inject({
      method: "GET",
      url: "/internal/document-sync/sources?includeLatestSnapshot=maybe",
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ ok: false, error: "invalid_request" });
  });

  it("returns a document source by id", async () => {
    const runtime = fakeDocumentSyncRuntime({
      sources: {
        list: vi.fn(),
        get: vi.fn(async () => authorizedWikiSource()),
        updatePolicy: vi.fn(),
        listSnapshots: vi.fn(),
        getSnapshot: vi.fn(),
        getLatestSnapshot: vi.fn(),
        getLatestSnapshots: vi.fn(),
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

  it("returns a document source by id with latest snapshot summary", async () => {
    const runtime = fakeDocumentSyncRuntime({
      sources: {
        list: vi.fn(),
        get: vi.fn(async () => authorizedWikiSource()),
        updatePolicy: vi.fn(),
        listSnapshots: vi.fn(),
        getSnapshot: vi.fn(),
        getLatestSnapshot: vi.fn(async () => ({
          id: "snapshot-1",
          documentSourceId: "source-1",
          sourceUri: "https://docs.feishu.cn/docx/doc_token_1",
          fetchStatus: "succeeded" as const,
          bodyText: "Should not leak",
          contentHash: "hash-1",
          sourceVersion: undefined,
          fetchedAt: new Date("2026-07-03T04:00:00.000Z"),
          errorMessage: undefined,
          createdAt: new Date("2026-07-03T04:00:01.000Z"),
        })),
        getLatestSnapshots: vi.fn(),
      },
    });
    const app = buildApp({
      createAnswerDraftRuntime: () => undefined,
      createDocumentSyncRuntime: () => runtime,
    });

    const response = await app.inject({
      method: "GET",
      url: "/internal/document-sync/sources/source-1?includeLatestSnapshot=true",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().source).toMatchObject({
      id: "source-1",
      latestSnapshot: {
        id: "snapshot-1",
        documentSourceId: "source-1",
        sourceUri: "https://docs.feishu.cn/docx/doc_token_1",
        fetchStatus: "succeeded",
        contentHash: "hash-1",
        fetchedAt: "2026-07-03T04:00:00.000Z",
        createdAt: "2026-07-03T04:00:01.000Z",
        bodyTextLength: 15,
      },
    });
    expect(response.json().source.latestSnapshot).not.toHaveProperty("bodyText");
    expect(response.json().source.latestSnapshot).not.toHaveProperty("bodyTextPreview");
    expect(response.json().source.syncHealth).toEqual({
      status: "healthy",
      latestSnapshotId: "snapshot-1",
      lastFetchedAt: "2026-07-03T04:00:00.000Z",
    });
    expect(runtime.sources.get).toHaveBeenCalledWith("source-1");
    expect(runtime.sources.getLatestSnapshot).toHaveBeenCalledWith({ sourceId: "source-1" });
  });

  it("treats false source detail latest snapshot flags as omitted", async () => {
    const runtime = fakeDocumentSyncRuntime({
      sources: {
        list: vi.fn(),
        get: vi.fn(async () => authorizedWikiSource()),
        updatePolicy: vi.fn(),
        listSnapshots: vi.fn(),
        getSnapshot: vi.fn(),
        getLatestSnapshot: vi.fn(),
        getLatestSnapshots: vi.fn(),
      },
    });
    const app = buildApp({
      createAnswerDraftRuntime: () => undefined,
      createDocumentSyncRuntime: () => runtime,
    });

    const response = await app.inject({
      method: "GET",
      url: "/internal/document-sync/sources/source-1?includeLatestSnapshot=false",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().source).not.toHaveProperty("latestSnapshot");
    expect(runtime.sources.get).toHaveBeenCalledWith("source-1");
    expect(runtime.sources.getLatestSnapshot).not.toHaveBeenCalled();
  });

  it("rejects invalid source detail latest snapshot flags", async () => {
    const app = buildApp({
      createAnswerDraftRuntime: () => undefined,
      createDocumentSyncRuntime: () => fakeDocumentSyncRuntime(),
    });

    const response = await app.inject({
      method: "GET",
      url: "/internal/document-sync/sources/source-1?includeLatestSnapshot=maybe",
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ ok: false, error: "invalid_request" });
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
        updatePolicy: vi.fn(),
        listSnapshots: vi.fn(),
        getSnapshot: vi.fn(),
        getLatestSnapshot: vi.fn(),
        getLatestSnapshots: vi.fn(),
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

describe("document sync source policy API", () => {
  it("returns 503 when updating source policy without document sync runtime", async () => {
    const app = buildApp({
      createAnswerDraftRuntime: () => undefined,
      createDocumentSyncRuntime: () => undefined,
    });

    const response = await app.inject({
      method: "PATCH",
      url: "/internal/document-sync/sources/source-1/policy",
      payload: { canUseForAnswering: false },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ ok: false, error: "document_sync_worker_unavailable" });
  });

  it("updates document source policy", async () => {
    const updatedSource = {
      ...authorizedWikiSource(),
      canUseForAnswering: false,
      canUseForKnowledgeDrafts: false,
    };
    const runtime = fakeDocumentSyncRuntime({
      sources: {
        list: vi.fn(),
        get: vi.fn(),
        updatePolicy: vi.fn(async () => updatedSource),
        listSnapshots: vi.fn(),
        getSnapshot: vi.fn(),
        getLatestSnapshot: vi.fn(),
        getLatestSnapshots: vi.fn(),
      },
    });
    const app = buildApp({
      createAnswerDraftRuntime: () => undefined,
      createDocumentSyncRuntime: () => runtime,
    });

    const response = await app.inject({
      method: "PATCH",
      url: "/internal/document-sync/sources/source-1/policy",
      payload: {
        canUseForAnswering: false,
        canUseForKnowledgeDrafts: false,
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
        canUseForAnswering: false,
        canUseForKnowledgeDrafts: false,
        createdAt: "2026-07-03T03:00:00.000Z",
        updatedAt: "2026-07-03T03:00:00.000Z",
        evidence: [],
      },
    });
    expect(runtime.sources.updatePolicy).toHaveBeenCalledWith({
      id: "source-1",
      canUseForAnswering: false,
      canUseForKnowledgeDrafts: false,
    });
  });

  it("returns 404 when updating policy for an unknown source", async () => {
    const app = buildApp({
      createAnswerDraftRuntime: () => undefined,
      createDocumentSyncRuntime: () => fakeDocumentSyncRuntime(),
    });

    const response = await app.inject({
      method: "PATCH",
      url: "/internal/document-sync/sources/missing/policy",
      payload: { canUseForAnswering: false },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ ok: false, error: "document_source_not_found" });
  });

  it("rejects invalid source policy update requests", async () => {
    const app = buildApp({
      createAnswerDraftRuntime: () => undefined,
      createDocumentSyncRuntime: () => fakeDocumentSyncRuntime(),
    });

    const response = await app.inject({
      method: "PATCH",
      url: "/internal/document-sync/sources/source-1/policy",
      payload: { canUseForAnswering: "false" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ ok: false, error: "invalid_request" });
  });

  it("returns 500 when source policy update fails", async () => {
    const runtime = fakeDocumentSyncRuntime({
      sources: {
        list: vi.fn(),
        get: vi.fn(),
        updatePolicy: vi.fn(async () => {
          throw new Error("database unavailable");
        }),
        listSnapshots: vi.fn(),
        getSnapshot: vi.fn(),
        getLatestSnapshot: vi.fn(),
        getLatestSnapshots: vi.fn(),
      },
    });
    const app = buildApp({
      createAnswerDraftRuntime: () => undefined,
      createDocumentSyncRuntime: () => runtime,
    });

    const response = await app.inject({
      method: "PATCH",
      url: "/internal/document-sync/sources/source-1/policy",
      payload: { canUseForKnowledgeDrafts: false },
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ ok: false, error: "document_source_policy_update_failed" });
  });
});

describe("document sync source snapshot inventory API", () => {
  it("returns 503 when listing source snapshots without document sync runtime", async () => {
    const app = buildApp({
      createAnswerDraftRuntime: () => undefined,
      createDocumentSyncRuntime: () => undefined,
    });

    const response = await app.inject({
      method: "GET",
      url: "/internal/document-sync/sources/source-1/snapshots",
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ ok: false, error: "document_sync_worker_unavailable" });
  });

  it("lists document source snapshot summaries without body text", async () => {
    const runtime = fakeDocumentSyncRuntime({
      sources: {
        list: vi.fn(),
        get: vi.fn(),
        updatePolicy: vi.fn(),
        listSnapshots: vi.fn(async () => [
          {
            id: "snapshot-1",
            documentSourceId: "source-1",
            sourceUri: "https://docs.feishu.cn/docx/doc_token_1",
            fetchStatus: "succeeded" as const,
            bodyText: "Document body",
            contentHash: "hash-1",
            sourceVersion: "v1",
            fetchedAt: new Date("2026-07-03T04:00:00.000Z"),
            errorMessage: undefined,
            createdAt: new Date("2026-07-03T04:00:01.000Z"),
          },
          {
            id: "snapshot-2",
            documentSourceId: "source-1",
            sourceUri: "https://docs.feishu.cn/docx/doc_token_1",
            fetchStatus: "failed" as const,
            bodyText: undefined,
            contentHash: undefined,
            sourceVersion: undefined,
            fetchedAt: new Date("2026-07-03T03:00:00.000Z"),
            errorMessage: "Feishu returned 403",
            createdAt: new Date("2026-07-03T03:00:01.000Z"),
          },
        ]),
        getSnapshot: vi.fn(),
        getLatestSnapshot: vi.fn(),
        getLatestSnapshots: vi.fn(),
      },
    });
    const app = buildApp({
      createAnswerDraftRuntime: () => undefined,
      createDocumentSyncRuntime: () => runtime,
    });

    const response = await app.inject({
      method: "GET",
      url: "/internal/document-sync/sources/source-1/snapshots?limit=2",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      snapshots: [
        {
          id: "snapshot-1",
          documentSourceId: "source-1",
          sourceUri: "https://docs.feishu.cn/docx/doc_token_1",
          fetchStatus: "succeeded",
          contentHash: "hash-1",
          sourceVersion: "v1",
          fetchedAt: "2026-07-03T04:00:00.000Z",
          createdAt: "2026-07-03T04:00:01.000Z",
          bodyTextLength: 13,
        },
        {
          id: "snapshot-2",
          documentSourceId: "source-1",
          sourceUri: "https://docs.feishu.cn/docx/doc_token_1",
          fetchStatus: "failed",
          fetchedAt: "2026-07-03T03:00:00.000Z",
          errorMessage: "Feishu returned 403",
          createdAt: "2026-07-03T03:00:01.000Z",
        },
      ],
    });
    expect(response.json().snapshots[0]).not.toHaveProperty("bodyText");
    expect(runtime.sources.listSnapshots).toHaveBeenCalledWith({ id: "source-1", limit: 2 });
  });

  it("returns a document source snapshot summary without body text", async () => {
    const runtime = fakeDocumentSyncRuntime({
      sources: {
        list: vi.fn(),
        get: vi.fn(),
        updatePolicy: vi.fn(),
        listSnapshots: vi.fn(),
        getSnapshot: vi.fn(async () => ({
          id: "snapshot-1",
          documentSourceId: "source-1",
          sourceUri: "https://docs.feishu.cn/docx/doc_token_1",
          fetchStatus: "succeeded" as const,
          bodyText: "Document body",
          contentHash: "hash-1",
          sourceVersion: "v1",
          fetchedAt: new Date("2026-07-03T04:00:00.000Z"),
          errorMessage: undefined,
          createdAt: new Date("2026-07-03T04:00:01.000Z"),
        })),
        getLatestSnapshot: vi.fn(),
        getLatestSnapshots: vi.fn(),
      },
    });
    const app = buildApp({
      createAnswerDraftRuntime: () => undefined,
      createDocumentSyncRuntime: () => runtime,
    });

    const response = await app.inject({
      method: "GET",
      url: "/internal/document-sync/sources/source-1/snapshots/snapshot-1",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      snapshot: {
        id: "snapshot-1",
        documentSourceId: "source-1",
        sourceUri: "https://docs.feishu.cn/docx/doc_token_1",
        fetchStatus: "succeeded",
        contentHash: "hash-1",
        sourceVersion: "v1",
        fetchedAt: "2026-07-03T04:00:00.000Z",
        createdAt: "2026-07-03T04:00:01.000Z",
        bodyTextLength: 13,
      },
    });
    expect(response.json().snapshot).not.toHaveProperty("bodyText");
    expect(response.json().snapshot).not.toHaveProperty("bodyTextPreview");
    expect(runtime.sources.getSnapshot).toHaveBeenCalledWith({
      sourceId: "source-1",
      snapshotId: "snapshot-1",
    });
  });

  it("returns an explicit capped document source snapshot body preview", async () => {
    const runtime = fakeDocumentSyncRuntime({
      sources: {
        list: vi.fn(),
        get: vi.fn(),
        updatePolicy: vi.fn(),
        listSnapshots: vi.fn(),
        getSnapshot: vi.fn(async () => ({
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
        })),
        getLatestSnapshot: vi.fn(),
        getLatestSnapshots: vi.fn(),
      },
    });
    const app = buildApp({
      createAnswerDraftRuntime: () => undefined,
      createDocumentSyncRuntime: () => runtime,
    });

    const response = await app.inject({
      method: "GET",
      url: "/internal/document-sync/sources/source-1/snapshots/snapshot-1?previewLength=8",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().snapshot).toMatchObject({
      id: "snapshot-1",
      bodyTextLength: 13,
      bodyTextPreview: "Document",
    });
    expect(response.json().snapshot).not.toHaveProperty("bodyText");
  });

  it("returns an empty document source snapshot body preview when requested", async () => {
    const runtime = fakeDocumentSyncRuntime({
      sources: {
        list: vi.fn(),
        get: vi.fn(),
        updatePolicy: vi.fn(),
        listSnapshots: vi.fn(),
        getSnapshot: vi.fn(async () => ({
          id: "snapshot-1",
          documentSourceId: "source-1",
          sourceUri: "https://docs.feishu.cn/docx/doc_token_1",
          fetchStatus: "succeeded" as const,
          bodyText: "Document body",
          contentHash: undefined,
          sourceVersion: undefined,
          fetchedAt: new Date("2026-07-03T04:00:00.000Z"),
          errorMessage: undefined,
          createdAt: new Date("2026-07-03T04:00:01.000Z"),
        })),
        getLatestSnapshot: vi.fn(),
        getLatestSnapshots: vi.fn(),
      },
    });
    const app = buildApp({
      createAnswerDraftRuntime: () => undefined,
      createDocumentSyncRuntime: () => runtime,
    });

    const response = await app.inject({
      method: "GET",
      url: "/internal/document-sync/sources/source-1/snapshots/snapshot-1?previewLength=0",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().snapshot).toMatchObject({
      id: "snapshot-1",
      bodyTextLength: 13,
      bodyTextPreview: "",
    });
  });

  it("returns the latest document source snapshot summary without body text", async () => {
    const runtime = fakeDocumentSyncRuntime({
      sources: {
        list: vi.fn(),
        get: vi.fn(),
        updatePolicy: vi.fn(),
        listSnapshots: vi.fn(),
        getSnapshot: vi.fn(),
        getLatestSnapshot: vi.fn(async () => ({
          id: "snapshot-latest",
          documentSourceId: "source-1",
          sourceUri: "https://docs.feishu.cn/docx/doc_token_1",
          fetchStatus: "succeeded" as const,
          bodyText: "Latest document body",
          contentHash: "hash-latest",
          sourceVersion: undefined,
          fetchedAt: new Date("2026-07-03T05:00:00.000Z"),
          errorMessage: undefined,
          createdAt: new Date("2026-07-03T05:00:01.000Z"),
        })),
        getLatestSnapshots: vi.fn(),
      },
    });
    const app = buildApp({
      createAnswerDraftRuntime: () => undefined,
      createDocumentSyncRuntime: () => runtime,
    });

    const response = await app.inject({
      method: "GET",
      url: "/internal/document-sync/sources/source-1/snapshots/latest",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      snapshot: {
        id: "snapshot-latest",
        documentSourceId: "source-1",
        sourceUri: "https://docs.feishu.cn/docx/doc_token_1",
        fetchStatus: "succeeded",
        contentHash: "hash-latest",
        fetchedAt: "2026-07-03T05:00:00.000Z",
        createdAt: "2026-07-03T05:00:01.000Z",
        bodyTextLength: 20,
      },
    });
    expect(response.json().snapshot).not.toHaveProperty("bodyText");
    expect(response.json().snapshot).not.toHaveProperty("bodyTextPreview");
    expect(runtime.sources.getLatestSnapshot).toHaveBeenCalledWith({ sourceId: "source-1" });
    expect(runtime.sources.getSnapshot).not.toHaveBeenCalled();
  });

  it("returns a capped latest document source snapshot preview", async () => {
    const runtime = fakeDocumentSyncRuntime({
      sources: {
        list: vi.fn(),
        get: vi.fn(),
        updatePolicy: vi.fn(),
        listSnapshots: vi.fn(),
        getSnapshot: vi.fn(),
        getLatestSnapshot: vi.fn(async () => ({
          id: "snapshot-latest",
          documentSourceId: "source-1",
          sourceUri: "https://docs.feishu.cn/docx/doc_token_1",
          fetchStatus: "succeeded" as const,
          bodyText: "Latest document body",
          contentHash: undefined,
          sourceVersion: undefined,
          fetchedAt: new Date("2026-07-03T05:00:00.000Z"),
          errorMessage: undefined,
          createdAt: new Date("2026-07-03T05:00:01.000Z"),
        })),
        getLatestSnapshots: vi.fn(),
      },
    });
    const app = buildApp({
      createAnswerDraftRuntime: () => undefined,
      createDocumentSyncRuntime: () => runtime,
    });

    const response = await app.inject({
      method: "GET",
      url: "/internal/document-sync/sources/source-1/snapshots/latest?previewLength=6",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().snapshot).toMatchObject({
      id: "snapshot-latest",
      bodyTextLength: 20,
      bodyTextPreview: "Latest",
    });
    expect(response.json().snapshot).not.toHaveProperty("bodyText");
  });

  it("returns 404 when the latest source snapshot is missing", async () => {
    const app = buildApp({
      createAnswerDraftRuntime: () => undefined,
      createDocumentSyncRuntime: () => fakeDocumentSyncRuntime(),
    });

    const response = await app.inject({
      method: "GET",
      url: "/internal/document-sync/sources/source-1/snapshots/latest",
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      ok: false,
      error: "document_source_snapshot_not_found",
    });
  });

  it("rejects invalid latest source snapshot preview lengths", async () => {
    const app = buildApp({
      createAnswerDraftRuntime: () => undefined,
      createDocumentSyncRuntime: () => fakeDocumentSyncRuntime(),
    });

    const response = await app.inject({
      method: "GET",
      url: "/internal/document-sync/sources/source-1/snapshots/latest?previewLength=nope",
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ ok: false, error: "invalid_request" });
  });

  it("returns 500 when latest source snapshot lookup fails", async () => {
    const runtime = fakeDocumentSyncRuntime({
      sources: {
        list: vi.fn(),
        get: vi.fn(),
        updatePolicy: vi.fn(),
        listSnapshots: vi.fn(),
        getSnapshot: vi.fn(),
        getLatestSnapshot: vi.fn(async () => {
          throw new Error("database unavailable");
        }),
        getLatestSnapshots: vi.fn(),
      },
    });
    const app = buildApp({
      createAnswerDraftRuntime: () => undefined,
      createDocumentSyncRuntime: () => runtime,
    });

    const response = await app.inject({
      method: "GET",
      url: "/internal/document-sync/sources/source-1/snapshots/latest",
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      ok: false,
      error: "document_source_snapshot_lookup_failed",
    });
  });

  it("returns 503 when reading a source snapshot without document sync runtime", async () => {
    const app = buildApp({
      createAnswerDraftRuntime: () => undefined,
      createDocumentSyncRuntime: () => undefined,
    });

    const response = await app.inject({
      method: "GET",
      url: "/internal/document-sync/sources/source-1/snapshots/snapshot-1",
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ ok: false, error: "document_sync_worker_unavailable" });
  });

  it("returns 404 when reading an unknown source snapshot", async () => {
    const app = buildApp({
      createAnswerDraftRuntime: () => undefined,
      createDocumentSyncRuntime: () => fakeDocumentSyncRuntime(),
    });

    const response = await app.inject({
      method: "GET",
      url: "/internal/document-sync/sources/source-1/snapshots/missing",
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      ok: false,
      error: "document_source_snapshot_not_found",
    });
  });

  it("rejects invalid source snapshot detail ids", async () => {
    const app = buildApp({
      createAnswerDraftRuntime: () => undefined,
      createDocumentSyncRuntime: () => fakeDocumentSyncRuntime(),
    });

    const response = await app.inject({
      method: "GET",
      url: "/internal/document-sync/sources/source-1/snapshots/%20",
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ ok: false, error: "invalid_request" });
  });

  it("rejects invalid source snapshot preview lengths", async () => {
    const app = buildApp({
      createAnswerDraftRuntime: () => undefined,
      createDocumentSyncRuntime: () => fakeDocumentSyncRuntime(),
    });

    const response = await app.inject({
      method: "GET",
      url: "/internal/document-sync/sources/source-1/snapshots/snapshot-1?previewLength=2001",
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ ok: false, error: "invalid_request" });
  });

  it("returns 500 when source snapshot detail lookup fails", async () => {
    const runtime = fakeDocumentSyncRuntime({
      sources: {
        list: vi.fn(),
        get: vi.fn(),
        updatePolicy: vi.fn(),
        listSnapshots: vi.fn(),
        getSnapshot: vi.fn(async () => {
          throw new Error("database unavailable");
        }),
        getLatestSnapshot: vi.fn(),
        getLatestSnapshots: vi.fn(),
      },
    });
    const app = buildApp({
      createAnswerDraftRuntime: () => undefined,
      createDocumentSyncRuntime: () => runtime,
    });

    const response = await app.inject({
      method: "GET",
      url: "/internal/document-sync/sources/source-1/snapshots/snapshot-1",
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      ok: false,
      error: "document_source_snapshot_lookup_failed",
    });
  });

  it("returns 404 when listing snapshots for an unknown source", async () => {
    const app = buildApp({
      createAnswerDraftRuntime: () => undefined,
      createDocumentSyncRuntime: () => fakeDocumentSyncRuntime(),
    });

    const response = await app.inject({
      method: "GET",
      url: "/internal/document-sync/sources/missing/snapshots",
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ ok: false, error: "document_source_not_found" });
  });

  it("rejects invalid source snapshot list limits", async () => {
    const app = buildApp({
      createAnswerDraftRuntime: () => undefined,
      createDocumentSyncRuntime: () => fakeDocumentSyncRuntime(),
    });

    const response = await app.inject({
      method: "GET",
      url: "/internal/document-sync/sources/source-1/snapshots?limit=-1",
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ ok: false, error: "invalid_request" });
  });

  it("returns 500 when source snapshot lookup fails", async () => {
    const runtime = fakeDocumentSyncRuntime({
      sources: {
        list: vi.fn(),
        get: vi.fn(),
        updatePolicy: vi.fn(),
        listSnapshots: vi.fn(async () => {
          throw new Error("database unavailable");
        }),
        getSnapshot: vi.fn(),
        getLatestSnapshot: vi.fn(),
        getLatestSnapshots: vi.fn(),
      },
    });
    const app = buildApp({
      createAnswerDraftRuntime: () => undefined,
      createDocumentSyncRuntime: () => runtime,
    });

    const response = await app.inject({
      method: "GET",
      url: "/internal/document-sync/sources/source-1/snapshots",
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      ok: false,
      error: "document_source_snapshot_lookup_failed",
    });
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
      payload: { ids: ["dlq-1", "missing", "dlq-1", "legacy:0:abc", "missing"] },
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
    const observedAt = new Date("2026-07-03T05:00:00.000Z");
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
      now: () => observedAt,
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
      observedAt,
    });
  });

  it("normalizes copied authorized wiki document URLs before registration", async () => {
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
        sourceUri: "https://docs.feishu.cn/docx/doc_token_1?from=copy#heading",
        authorizedSpaceId: "space-1",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(runtime.registerAuthorizedWikiDocument).toHaveBeenCalledWith({
      sourceUri: "https://docs.feishu.cn/docx/doc_token_1",
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

  it("rejects oversized authorized wiki document titles before registration", async () => {
    const runtime = fakeDocumentSyncRuntime();
    const app = buildApp({
      createAnswerDraftRuntime: () => undefined,
      createDocumentSyncRuntime: () => runtime,
    });

    const response = await app.inject({
      method: "POST",
      url: "/internal/document-sync/authorized-wiki-documents",
      payload: {
        sourceUri: "https://docs.feishu.cn/docx/doc_token_1",
        title: "t".repeat(513),
        authorizedSpaceId: "space-1",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ ok: false, error: "invalid_request" });
    expect(runtime.registerAuthorizedWikiDocument).not.toHaveBeenCalled();
  });

  it("rejects unsupported authorized wiki document URLs before registration", async () => {
    const runtime = fakeDocumentSyncRuntime();
    const app = buildApp({
      createAnswerDraftRuntime: () => undefined,
      createDocumentSyncRuntime: () => runtime,
    });

    const response = await app.inject({
      method: "POST",
      url: "/internal/document-sync/authorized-wiki-documents",
      payload: {
        sourceUri: "https://docs.feishu.cn/file/file_token_1",
        authorizedSpaceId: "space-1",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ ok: false, error: "invalid_request" });
    expect(runtime.registerAuthorizedWikiDocument).not.toHaveBeenCalled();
  });

  it("rejects authorized wiki document URLs with embedded credentials", async () => {
    const runtime = fakeDocumentSyncRuntime();
    const app = buildApp({
      createAnswerDraftRuntime: () => undefined,
      createDocumentSyncRuntime: () => runtime,
    });

    const response = await app.inject({
      method: "POST",
      url: "/internal/document-sync/authorized-wiki-documents",
      payload: {
        sourceUri: "https://user:pass@docs.feishu.cn/docx/doc_token_1",
        authorizedSpaceId: "space-1",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ ok: false, error: "invalid_request" });
    expect(runtime.registerAuthorizedWikiDocument).not.toHaveBeenCalled();
  });

  it("rejects non-HTTPS authorized wiki document URLs before registration", async () => {
    const runtime = fakeDocumentSyncRuntime();
    const app = buildApp({
      createAnswerDraftRuntime: () => undefined,
      createDocumentSyncRuntime: () => runtime,
    });

    const response = await app.inject({
      method: "POST",
      url: "/internal/document-sync/authorized-wiki-documents",
      payload: {
        sourceUri: "http://docs.feishu.cn/docx/doc_token_1",
        authorizedSpaceId: "space-1",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ ok: false, error: "invalid_request" });
    expect(runtime.registerAuthorizedWikiDocument).not.toHaveBeenCalled();
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
    const observedAt = new Date("2026-07-03T05:10:00.000Z");
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
      now: () => observedAt,
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
      observedAt,
    });
  });

  it("normalizes copied user submitted document URLs before registration", async () => {
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
        sourceUri: "https://docs.feishu.cn/docx/user_doc_token_1?open=1#top",
        submittedByUserId: "ou_1",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(runtime.registerUserSubmittedDocument).toHaveBeenCalledWith({
      sourceUri: "https://docs.feishu.cn/docx/user_doc_token_1",
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

  it("rejects unsupported user submitted document URLs before registration", async () => {
    const runtime = fakeDocumentSyncRuntime();
    const app = buildApp({
      createAnswerDraftRuntime: () => undefined,
      createDocumentSyncRuntime: () => runtime,
    });

    const response = await app.inject({
      method: "POST",
      url: "/internal/document-sync/user-submitted-documents",
      payload: {
        sourceUri: "https://example.com/not-readable",
        submittedByUserId: "ou_1",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ ok: false, error: "invalid_request" });
    expect(runtime.registerUserSubmittedDocument).not.toHaveBeenCalled();
  });

  it("rejects non-HTTPS user submitted document URLs before registration", async () => {
    const runtime = fakeDocumentSyncRuntime();
    const app = buildApp({
      createAnswerDraftRuntime: () => undefined,
      createDocumentSyncRuntime: () => runtime,
    });

    const response = await app.inject({
      method: "POST",
      url: "/internal/document-sync/user-submitted-documents",
      payload: {
        sourceUri: "http://docs.feishu.cn/docx/user_doc_token_1",
        submittedByUserId: "ou_1",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ ok: false, error: "invalid_request" });
    expect(runtime.registerUserSubmittedDocument).not.toHaveBeenCalled();
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
    getStatus: vi.fn(async () => ({
      enabled: true as const,
      running: true,
      intervalMs: 1000,
      batchLimit: 50,
      mentionRepliesEnabled: false,
      pendingEventCount: 0,
      deadLetterEventCount: 0,
    })),
    start: vi.fn(),
    close: vi.fn(async () => undefined),
    ...overrides,
  };
}

function rawEventFixture(overrides: Partial<RawEvent> = {}): RawEvent {
  return {
    idempotencyKey: "raw-event:feishu:event-1",
    provider: "feishu",
    eventType: "im.message.receive_v1",
    rawBody: { event_id: "event-1" },
    receivedAt: new Date("2026-07-02T01:00:00.000Z"),
    attempts: 0,
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
      updatePolicy: vi.fn(async () => undefined),
      listSnapshots: vi.fn(async () => undefined),
      getSnapshot: vi.fn(async () => undefined),
      getLatestSnapshot: vi.fn(async () => undefined),
      getLatestSnapshots: vi.fn(async () => new Map()),
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
