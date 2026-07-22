import { describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import type { KnowledgeDraft } from "../src/knowledge-governance/knowledge-draft-repository.js";
import type {
  KnowledgeCardRuntime,
  KnowledgeCardRuntimeRepository,
} from "../src/runtime/knowledge-card-runtime.js";
import type { KnowledgeDraftPresentation } from "../src/knowledge-cards/knowledge-card-repository.js";
import { KnowledgeCardOperationConflictError } from "../src/knowledge-cards/postgres-knowledge-card-repository.js";

const authorization = { authorization: "Bearer operator-secret" };

describe("knowledge card API", () => {
  it("always returns a safe HTTP 200 error toast when the public runtime is absent", async () => {
    const app = createApp(undefined);
    const response = await app.inject({
      method: "POST",
      url: "/feishu/card-actions",
      payload: { arbitrary: "callback" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      toast: { type: "error", content: expect.any(String) },
    });
    await app.close();
  });

  it("uses only the fast verified gateway on the public callback path", async () => {
    const runtime = runtimeFixture();
    vi.mocked(runtime.gateway.handleCallback).mockResolvedValue({
      statusCode: 200,
      body: { toast: { type: "info", content: "accepted" } },
    });
    const app = createApp(runtime);
    const response = await app.inject({
      method: "POST",
      url: "/feishu/card-actions",
      headers: { "x-lark-signature": "signature" },
      payload: { schema: "2.0", event: { action: {} } },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ toast: { type: "info", content: "accepted" } });
    expect(runtime.gateway.handleCallback).toHaveBeenCalledWith({
      headers: expect.objectContaining({ "x-lark-signature": "signature" }),
      body: { schema: "2.0", event: { action: {} } },
      rawBody: expect.any(String),
    });
    expect(runtime.repository.getDraft).not.toHaveBeenCalled();
    await app.close();
  });

  it("creates a presentation from current server-owned draft metadata and full rendered content", async () => {
    const runtime = runtimeFixture();
    const inputs: Array<Parameters<KnowledgeCardRuntimeRepository["createPresentation"]>[0]> = [];
    vi.mocked(runtime.repository.createPresentation).mockImplementation(async (input) => {
      inputs.push(input);
      return {
        outcome: "applied",
        presentation: presentation({
          id: input.id,
          draftId: input.draftId,
          revisionNumber: input.expectedRevisionNumber,
          draftVersion: input.expectedDraftVersion,
          chatId: input.chatId,
          contentHash: input.contentHash,
          createdAt: input.at,
        }),
        draft: currentDraft(),
      };
    });
    vi.mocked(runtime.repository.getPresentation).mockImplementation(async (id) =>
      inputs[0] === undefined
        ? undefined
        : presentation({
            id,
            draftId: inputs[0].draftId,
            revisionNumber: inputs[0].expectedRevisionNumber,
            draftVersion: inputs[0].expectedDraftVersion,
            chatId: inputs[0].chatId,
            contentHash: inputs[0].contentHash,
            createdAt: inputs[0].at,
          }));
    const app = createApp(runtime);
    const request = {
      method: "POST" as const,
      url: "/internal/knowledge-drafts/draft-1/presentations",
      headers: authorization,
      payload: { expectedVersion: 7, operationKey: "presentation-operation-1" },
    };
    const first = await app.inject(request);
    const replay = await app.inject(request);

    expect(first.statusCode).toBe(200);
    expect(replay.statusCode).toBe(200);
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toEqual({
      id: expect.stringMatching(/^knowledge-card-[a-f0-9]{40}$/u),
      draftId: "draft-1",
      expectedDraftVersion: 7,
      expectedRevisionNumber: 3,
      chatId: "oc_pilot",
      contentHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      operationKey: "presentation-operation-1",
      at: new Date("2026-07-19T08:00:00.000Z"),
    });
    expect(runtime.repository.getPresentation).toHaveBeenCalledTimes(2);
    expect(replay.json()).toMatchObject({ ok: true, outcome: "already_applied" });
    expect(runtime.canUseKnowledgeCards).toHaveBeenCalledWith("oc_pilot");
    expect(first.json()).toEqual({
      ok: true,
      outcome: "applied",
      presentation: expect.objectContaining({
        id: inputs[0]?.id,
        draftId: "draft-1",
        revisionNumber: 3,
        draftVersion: 7,
        chatId: "oc_pilot",
        suggestedPublicationApproved: false,
      }),
    });
    const serialized = first.body;
    for (const secret of [
      "Full governed draft body",
      "evidence-message-1",
      "space-suggestion",
      "parent-suggestion",
      "reviewer-secret",
    ]) expect(serialized).not.toContain(secret);
    await app.close();
  });

  it("requires the exact two-field create body and rejects caller-supplied authority", async () => {
    const runtime = runtimeFixture();
    const app = createApp(runtime);
    for (const payload of [
      { expectedVersion: 7 },
      { expectedVersion: 7, operationKey: "operation", revisionNumber: 3 },
      { expectedVersion: 7, operationKey: "operation", body: "caller body" },
      { expectedVersion: 7, operationKey: "operation", contentHash: "0".repeat(64) },
      { expectedVersion: 7, operationKey: "operation", chatId: "oc_other" },
    ]) {
      const response = await app.inject({
        method: "POST",
        url: "/internal/knowledge-drafts/draft-1/presentations",
        headers: authorization,
        payload,
      });
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
    }
    expect(runtime.repository.getDraft).not.toHaveBeenCalled();
    expect(runtime.repository.createPresentation).not.toHaveBeenCalled();
    await app.close();
  });

  it("recovers an identical concurrent create as an idempotent replay", async () => {
    const runtime = runtimeFixture();
    let committed: KnowledgeDraftPresentation | undefined;
    vi.mocked(runtime.repository.getPresentation).mockImplementation(async () => committed);
    vi.mocked(runtime.repository.createPresentation).mockImplementation(async (input) => {
      committed = presentation({
        id: input.id,
        draftId: input.draftId,
        revisionNumber: input.expectedRevisionNumber,
        draftVersion: input.expectedDraftVersion,
        chatId: input.chatId,
        contentHash: input.contentHash,
        createdAt: input.at,
      });
      throw new KnowledgeCardOperationConflictError();
    });
    const app = createApp(runtime);
    const response = await app.inject({
      method: "POST",
      url: "/internal/knowledge-drafts/draft-1/presentations",
      headers: authorization,
      payload: { expectedVersion: 7, operationKey: "concurrent-operation" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, outcome: "already_applied" });
    expect(runtime.repository.getPresentation).toHaveBeenCalledTimes(2);
    await app.close();
  });

  it("returns review_surface_required without persistence when full content cannot be rendered", async () => {
    const runtime = runtimeFixture();
    vi.mocked(runtime.repository.getDraft).mockResolvedValue(currentDraft({ content: "x".repeat(8_001) }));
    const app = createApp(runtime);
    const response = await app.inject({
      method: "POST",
      url: "/internal/knowledge-drafts/draft-1/presentations",
      headers: authorization,
      payload: { expectedVersion: 7, operationKey: "overlong-operation" },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ ok: false, error: "review_surface_required" });
    expect(runtime.repository.createPresentation).not.toHaveBeenCalled();
    await app.close();
  });

  it("fails closed with 403 for a disabled runtime layer and 503 only when runtime is absent", async () => {
    const disabledRuntime = runtimeFixture();
    vi.mocked(disabledRuntime.canUseKnowledgeCards).mockReturnValue(false);
    const disabledApp = createApp(disabledRuntime);
    const disabled = await disabledApp.inject({
      method: "POST",
      url: "/internal/knowledge-drafts/draft-1/presentations",
      headers: authorization,
      payload: { expectedVersion: 7, operationKey: "disabled-operation" },
    });
    expect(disabled.statusCode).toBe(403);
    expect(disabled.json()).toEqual({ ok: false, error: "iris_runtime_disabled" });
    expect(disabledRuntime.repository.createPresentation).not.toHaveBeenCalled();
    await disabledApp.close();

    const absentApp = createApp(undefined);
    const absent = await absentApp.inject({
      method: "POST",
      url: "/internal/knowledge-drafts/draft-1/presentations",
      headers: authorization,
      payload: { expectedVersion: 7, operationKey: "absent-operation" },
    });
    expect(absent.statusCode).toBe(503);
    expect(absent.json()).toEqual({ ok: false, error: "knowledge_card_runtime_unavailable" });
    await absentApp.close();
  });

  it("lists bounded presentations and reports content-free queue and loop status", async () => {
    const runtime = runtimeFixture();
    vi.mocked(runtime.repository.listPresentations).mockResolvedValue([presentation()]);
    const app = createApp(runtime);
    const list = await app.inject({
      method: "GET",
      url: "/internal/knowledge-drafts/draft-1/presentations?limit=7",
      headers: authorization,
    });
    const status = await app.inject({
      method: "GET",
      url: "/internal/approval-interactions/status",
      headers: authorization,
    });

    expect(list.statusCode).toBe(200);
    expect(runtime.repository.listPresentations).toHaveBeenCalledWith({ draftId: "draft-1", limit: 7 });
    expect(list.json()).toEqual({
      ok: true,
      presentations: [expect.objectContaining({
        id: "presentation-1",
        suggestedPublicationApproved: false,
      })],
    });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toEqual({ ok: true, ...(await runtime.getStatus()) });
    expect(status.body).not.toMatch(/body|evidence|reason|actorOpenId|token-secret/u);

    for (const url of [
      "/internal/knowledge-drafts/draft-1/presentations?limit=0",
      "/internal/knowledge-drafts/draft-1/presentations?limit=101",
      "/internal/knowledge-drafts/draft-1/presentations?limit=7&extra=true",
    ]) expect((await app.inject({ method: "GET", url, headers: authorization })).statusCode).toBe(400);
    await app.close();
  });

  it("adds content-free knowledge cards to consolidated status and enabled readiness", async () => {
    const runtime = runtimeFixture();
    const app = createApp(runtime, {
      readinessEnv: {
        DATABASE_URL: "postgres://iris:iris@localhost:5432/iris",
        REDIS_URL: "redis://localhost:6379",
        IRIS_INTERNAL_API_TOKEN: "operator-secret",
        FEISHU_VERIFICATION_TOKEN: "verification-token",
        FEISHU_APP_ID: "app-id",
        FEISHU_APP_SECRET: "app-secret",
        IRIS_FEISHU_BOT_OPEN_ID: "ou_irisbot",
        IRIS_EVENT_WORKER_ENABLED: "true",
        IRIS_DOCUMENT_SYNC_WORKER_ENABLED: "true",
        IRIS_REINDEX_WORKER_ENABLED: "true",
        IRIS_ENABLE_INTERNAL_ANSWER_DRAFTS: "true",
        IRIS_INTERNAL_DRAFT_PERMISSION_MODE: "source-policy",
        IRIS_MODEL_PROVIDER: "openai-compatible",
        IRIS_MODEL_BASE_URL: "https://model.example.com/v1",
        IRIS_MODEL_API_KEY: "model-key",
        IRIS_MODEL_NAME: "model-name",
        IRIS_EMBEDDING_PROVIDER: "openai-compatible",
        IRIS_EMBEDDING_BASE_URL: "https://embedding.example.com/v1",
        IRIS_EMBEDDING_API_KEY: "embedding-key",
        IRIS_EMBEDDING_MODEL: "embedding-model",
        IRIS_EMBEDDING_DIMENSIONS: "1536",
        IRIS_KNOWLEDGE_CARD_ENABLED: "true",
        IRIS_KNOWLEDGE_CARD_GROUP_IDS: "oc_pilot",
        FEISHU_ENCRYPT_KEY: "knowledge-card-encrypt-key",
      },
    });
    const status = await app.inject({ method: "GET", url: "/internal/status", headers: authorization });
    const readiness = await app.inject({ method: "GET", url: "/internal/readiness", headers: authorization });

    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({
      componentOrder: expect.not.arrayContaining(["knowledgeCards"]),
      knowledgeCards: {
        ok: true,
        enabled: true,
        running: true,
        queue: { pending: 1, processing: 2, delayed: 3, deadLetter: 4 },
        outbox: {
          pending: 5,
          processing: 6,
          external_attempting: 7,
          sent: 8,
          failed: 9,
          outcome_unknown: 0,
          terminalFailed: 0,
        },
      },
    });
    expect(readiness.statusCode).toBe(200);
    expect(readiness.json().checks).toContainEqual(expect.objectContaining({
      id: "knowledgeCards",
      status: "pass",
    }));
    expect(status.body).not.toMatch(/Full governed draft body|evidence-message-1|token-secret/u);
    await app.close();
  });

  it("authenticates and bounds content-free DLQ list, replay, and delete operations", async () => {
    const runtime = runtimeFixture();
    vi.mocked(runtime.deadLetters.list).mockResolvedValue([
      {
        id: "dlq-1",
        replayable: true,
        errorCode: "membership_unavailable",
        failedAt: new Date("2026-07-19T08:01:00.000Z"),
        job: {
          kind: "knowledge_draft_confirmation",
          idempotencyKey: "feishu-card:app:event-1",
          eventId: "event-1",
          appId: "app-id",
          actorOpenId: "ou_actor_secret",
          chatId: "oc_pilot",
          messageId: "message-1",
          presentationId: "presentation-1",
          draftId: "draft-1",
          revisionNumber: 3,
          draftVersion: 7,
          action: "request_revision",
          intentId: "intent-1",
          receivedAt: new Date("2026-07-19T08:00:00.000Z"),
          attempts: 2,
        },
      },
      {
        id: "dlq-proposal",
        replayable: true,
        errorCode: "repository_unavailable",
        failedAt: new Date("2026-07-19T08:01:30.000Z"),
        job: {
          kind: "action_proposal_approval",
          idempotencyKey: "feishu-card:app:event-2",
          eventId: "event-2",
          appId: "app-id",
          actorOpenId: "ou_owner_secret",
          chatId: "oc_pilot",
          messageId: "message-2",
          presentationId: "proposal-presentation-1",
          proposalId: "proposal-1",
          requirementId: "requirement-1",
          proposalVersion: 4,
          subjectRevision: 2,
          subjectVersion: 7,
          targetPolicyVersion: 3,
          action: "approve",
          receivedAt: new Date("2026-07-19T08:01:00.000Z"),
          attempts: 1,
        },
      },
      {
        id: "dlq-lease-expired",
        attempts: 5,
        errorCode: "lease_expired",
        failedAt: new Date("2026-07-19T08:02:00.000Z"),
        replayable: false,
      },
      {
        id: "dlq-invalid-payload",
        payloadDigest: `sha256:${"a".repeat(64)}`,
        payloadBytes: 42,
        errorCode: "invalid_queue_payload",
        failedAt: new Date("2026-07-19T08:03:00.000Z"),
        replayable: false,
      },
    ]);
    vi.mocked(runtime.deadLetters.replay).mockResolvedValue("replayed");
    vi.mocked(runtime.deadLetters.delete).mockResolvedValue("deleted");
    const app = createApp(runtime);

    expect((await app.inject({
      method: "GET",
      url: "/internal/approval-interactions/dead-letters",
    })).statusCode).toBe(401);
    const list = await app.inject({
      method: "GET",
      url: "/internal/approval-interactions/dead-letters?limit=5",
      headers: authorization,
    });
    const replay = await app.inject({
      method: "POST",
      url: "/internal/approval-interactions/dead-letters/dlq-1/replay",
      headers: authorization,
    });
    const deleted = await app.inject({
      method: "DELETE",
      url: "/internal/approval-interactions/dead-letters/dlq-1",
      headers: authorization,
    });

    expect(runtime.deadLetters.list).toHaveBeenCalledWith({ limit: 5 });
    expect(list.json()).toEqual({
      ok: true,
      deadLetters: [
        {
          id: "dlq-1",
          replayable: true,
          errorCode: "membership_unavailable",
          failedAt: "2026-07-19T08:01:00.000Z",
          kind: "knowledge_draft_confirmation",
          presentationId: "presentation-1",
          draftId: "draft-1",
          revisionNumber: 3,
          draftVersion: 7,
          action: "request_revision",
          attempts: 2,
        },
        {
          id: "dlq-proposal",
          replayable: true,
          errorCode: "repository_unavailable",
          failedAt: "2026-07-19T08:01:30.000Z",
          kind: "action_proposal_approval",
          presentationId: "proposal-presentation-1",
          proposalId: "proposal-1",
          requirementId: "requirement-1",
          proposalVersion: 4,
          subjectRevision: 2,
          subjectVersion: 7,
          targetPolicyVersion: 3,
          action: "approve",
          attempts: 1,
        },
        {
          id: "dlq-lease-expired",
          replayable: false,
          errorCode: "lease_expired",
          failedAt: "2026-07-19T08:02:00.000Z",
          attempts: 5,
        },
        {
          id: "dlq-invalid-payload",
          replayable: false,
          errorCode: "invalid_queue_payload",
          failedAt: "2026-07-19T08:03:00.000Z",
          payloadDigest: `sha256:${"a".repeat(64)}`,
          payloadBytes: 42,
        },
      ],
    });
    expect(list.body).not.toMatch(/ou_(?:actor|owner)_secret|raw secret reason|token-secret|idempotencyKey/u);
    expect(replay.json()).toEqual({ ok: true, status: "replayed" });
    expect(deleted.json()).toEqual({ ok: true, status: "deleted" });

    for (const url of [
      "/internal/approval-interactions/dead-letters?limit=0",
      "/internal/approval-interactions/dead-letters?limit=101",
      "/internal/approval-interactions/dead-letters?limit=5&extra=true",
    ]) expect((await app.inject({ method: "GET", url, headers: authorization })).statusCode).toBe(400);
    await app.close();
  });
});

function createApp(
  runtime: KnowledgeCardRuntime | undefined,
  overrides: { readinessEnv?: Record<string, string | undefined> } = {},
) {
  return buildApp({
    internalApiToken: "operator-secret",
    now: () => new Date("2026-07-19T08:00:00.000Z"),
    createAnswerDraftRuntime: () => undefined,
    createMemoryExtractionRuntime: () => undefined,
    createEventWorkerRuntime: () => undefined,
    createDocumentSyncRuntime: () => undefined,
    createReindexWorkerRuntime: () => undefined,
    createConversationStateInspectionRuntime: () => undefined,
    createKnowledgeDraftRuntime: () => undefined,
    createKnowledgeCardRuntime: () => runtime,
    ...overrides,
  });
}

function runtimeFixture(): KnowledgeCardRuntime {
  const repository = {
    createPresentation: vi.fn(),
    claimPresentationSend: vi.fn(),
    beginExternalAttempt: vi.fn(),
    failPresentationPreparation: vi.fn(),
    completePresentationSend: vi.fn(),
    failPresentationSend: vi.fn(),
    applyInteraction: vi.fn(),
    getPresentation: vi.fn(),
    getPresentationContext: vi.fn(),
    listPresentations: vi.fn(async () => []),
    getStatusCounts: vi.fn(),
    getOutboxStatusCounts: vi.fn(),
    getDraft: vi.fn(async () => currentDraft()),
  };
  return {
    gateway: { handleCallback: vi.fn() },
    repository,
    deadLetters: {
      list: vi.fn(async () => []),
      replay: vi.fn(async () => "not_found" as const),
      delete: vi.fn(async () => "not_found" as const),
    },
    canUseKnowledgeCards: vi.fn(() => true),
    start: vi.fn(),
    getStatus: vi.fn(async () => ({
      enabled: true as const,
      running: true,
      enabledGroupCount: 1,
      dispatcher: { running: true, intervalMs: 1000, batchLimit: 10 },
      worker: { running: true, intervalMs: 1000, batchLimit: 10 },
      queue: { pending: 1, processing: 2, delayed: 3, deadLetter: 4 },
      presentations: {
        pending_send: 1,
        active: 2,
        superseded: 3,
        closed: 4,
        send_failed: 5,
        pendingSend: 1,
      },
      outbox: {
        pending: 5,
        processing: 6,
        external_attempting: 7,
        sent: 8,
        failed: 9,
        outcome_unknown: 0,
        terminalFailed: 0,
      },
    })),
    close: vi.fn(async () => undefined),
  };
}

function currentDraft(overrides: { content?: string } = {}): KnowledgeDraft {
  const at = new Date("2026-07-19T07:00:00.000Z");
  return {
    id: "draft-1",
    sourceGroupId: "oc_pilot",
    originKind: "group_conclusion",
    status: "pending_confirmation",
    currentRevisionNumber: 3,
    version: 7,
    createdBy: "iris",
    createdAt: at,
    updatedAt: at,
    currentRevision: {
      revisionNumber: 3,
      riskLevel: "medium",
      author: "iris",
      createdAt: at,
      evidenceState: { status: "current" },
      title: "Release checklist",
      content: overrides.content ?? "Full governed draft body",
      reviewer: { type: "text_label", ref: "reviewer-secret" },
      suggestedPublication: {
        spaceId: "space-suggestion",
        parentNodeToken: "parent-suggestion",
      },
      evidence: [{
        type: "conversation_message",
        id: "evidence-message-1",
        groupId: "oc_pilot",
      }],
    },
  };
}

function presentation(overrides: Partial<KnowledgeDraftPresentation> = {}): KnowledgeDraftPresentation {
  return {
    id: "presentation-1",
    draftId: "draft-1",
    revisionNumber: 3,
    draftVersion: 7,
    chatId: "oc_pilot",
    contentHash: "a".repeat(64),
    state: "pending_send" as const,
    createdAt: new Date("2026-07-19T08:00:00.000Z"),
    version: 1,
    ...overrides,
  };
}
