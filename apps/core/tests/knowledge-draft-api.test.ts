import { describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import {
  KnowledgeDraftEvidenceError,
  KnowledgeDraftVersionConflictError,
} from "../src/knowledge-governance/postgres-knowledge-draft-repository.js";
import type { KnowledgeDraftRuntime } from "../src/runtime/knowledge-draft-runtime.js";

const authorization = { authorization: "Bearer operator-secret" };

describe("knowledge draft governance API", () => {
  it("requires the internal bearer token for every governance surface", async () => {
    const runtime = runtimeFixture();
    const app = createApp(runtime);
    const routes = [
      { method: "POST" as const, url: "/internal/knowledge-drafts", payload: createPayload() },
      { method: "GET" as const, url: "/internal/knowledge-drafts" },
      { method: "GET" as const, url: "/internal/knowledge-drafts/status" },
      { method: "GET" as const, url: "/internal/knowledge-drafts/draft-1" },
      { method: "GET" as const, url: "/internal/knowledge-drafts/draft-1/events" },
      {
        method: "POST" as const,
        url: "/internal/knowledge-drafts/draft-1/revisions",
        payload: revisePayload(),
      },
      {
        method: "POST" as const,
        url: "/internal/knowledge-drafts/draft-1/request-revision",
        payload: transitionPayload(),
      },
      {
        method: "POST" as const,
        url: "/internal/knowledge-drafts/draft-1/reject",
        payload: transitionPayload(),
      },
    ];

    for (const route of routes) {
      expect((await app.inject(route)).statusCode, route.url).toBe(401);
      expect((await app.inject({
        ...route,
        headers: { authorization: "Bearer wrong" },
      })).statusCode, route.url).toBe(401);
    }
    expect(runtime.repository.createDraft).not.toHaveBeenCalled();
    await app.close();
  });

  it("fails closed when runtime or operator authentication is unavailable", async () => {
    const noRuntime = buildApp({ ...disabledRuntimeFactories(), internalApiToken: "operator-secret" });
    expect((await noRuntime.inject({
      method: "GET",
      url: "/internal/knowledge-drafts/status",
      headers: authorization,
    })).json()).toEqual({ ok: false, error: "knowledge_draft_runtime_unavailable" });
    await noRuntime.close();

    const runtime = runtimeFixture();
    const noAuth = buildApp({
      ...disabledRuntimeFactories(),
      createKnowledgeDraftRuntime: () => runtime,
    });
    expect((await noAuth.inject({
      method: "GET",
      url: "/internal/knowledge-drafts/status",
    })).json()).toEqual({ ok: false, error: "knowledge_draft_api_auth_unavailable" });
    await noAuth.close();
  });

  it("creates a normalized draft only while the exact runtime gate is open", async () => {
    const runtime = runtimeFixture();
    const app = createApp(runtime);
    const response = await app.inject({
      method: "POST",
      url: "/internal/knowledge-drafts",
      headers: authorization,
      payload: createPayload(),
    });

    expect(response.statusCode).toBe(200);
    expect(runtime.canCreateDraft).toHaveBeenCalledWith({ sourceGroupId: "group-1" });
    expect(runtime.repository.createDraft).toHaveBeenCalledWith({
      id: "draft-1",
      operationKey: "create-1",
      originKind: "group_conclusion",
      createdBy: "iris",
      at: expect.any(Date),
      revision: {
        sourceGroupId: "group-1",
        title: "Release checklist",
        content: "Run acceptance.",
        riskLevel: "medium",
        evidence: [
          { type: "conversation_message", id: "feishu:om_1", groupId: "group-1" },
          {
            type: "document_source",
            id: "source-1",
            expectedUpdatedAt: new Date("2026-07-18T04:00:00.000Z"),
          },
        ],
      },
    });
    expect(response.json()).toEqual({ ok: true, outcome: "applied", draft: expect.any(Object) });
    await app.close();

    const closedRuntime = runtimeFixture();
    vi.mocked(closedRuntime.canCreateDraft).mockReturnValue(false);
    const closedApp = createApp(closedRuntime);
    const blocked = await closedApp.inject({
      method: "POST",
      url: "/internal/knowledge-drafts",
      headers: authorization,
      payload: createPayload(),
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toEqual({ ok: false, error: "knowledge_draft_generation_disabled" });
    expect(closedRuntime.repository.createDraft).not.toHaveBeenCalled();
    await closedApp.close();
  });

  it("lists, reads, audits, and reports content-redacted repository results", async () => {
    const runtime = runtimeFixture();
    vi.mocked(runtime.repository.getDraft).mockResolvedValue(redactedDraft());
    vi.mocked(runtime.repository.listDrafts).mockResolvedValue([draft()]);
    vi.mocked(runtime.repository.listEvents).mockResolvedValue([event()]);
    const app = createApp(runtime);

    const list = await app.inject({
      method: "GET",
      url: "/internal/knowledge-drafts?groupId=group-1&status=pending_confirmation&riskLevel=medium&limit=7",
      headers: authorization,
    });
    const detail = await app.inject({
      method: "GET", url: "/internal/knowledge-drafts/draft-1", headers: authorization,
    });
    const events = await app.inject({
      method: "GET", url: "/internal/knowledge-drafts/draft-1/events", headers: authorization,
    });
    const status = await app.inject({
      method: "GET", url: "/internal/knowledge-drafts/status", headers: authorization,
    });

    expect(list.statusCode).toBe(200);
    expect(runtime.repository.listDrafts).toHaveBeenCalledWith({
      sourceGroupId: "group-1",
      statuses: ["pending_confirmation"],
      riskLevels: ["medium"],
      limit: 7,
    });
    expect(detail.json()).toEqual({ ok: true, draft: expect.objectContaining({
      currentRevision: {
        revisionNumber: 1,
        riskLevel: "medium",
        author: "iris",
        createdAt: "2026-07-18T05:00:00.000Z",
        evidenceState: { status: "invalidated", reason: "document_permission_unavailable" },
      },
    }) });
    expect(JSON.stringify(detail.json())).not.toContain("Run acceptance");
    expect(events.json()).toEqual({ ok: true, events: [expect.objectContaining({ eventType: "created" })] });
    expect(status.json()).toMatchObject({ ok: true, enabled: true, counts: { pending_confirmation: 1 } });
    await app.close();
  });

  it("allows governance mutations while creation is disabled and maps conflicts safely", async () => {
    const runtime = runtimeFixture();
    vi.mocked(runtime.canCreateDraft).mockReturnValue(false);
    const app = createApp(runtime);
    for (const [path, payload, method] of [
      ["revisions", revisePayload(), "reviseDraft"],
      ["request-revision", transitionPayload(), "requestRevision"],
      ["reject", transitionPayload(), "rejectDraft"],
    ] as const) {
      const response = await app.inject({
        method: "POST",
        url: `/internal/knowledge-drafts/draft-1/${path}`,
        headers: authorization,
        payload,
      });
      expect(response.statusCode, path).toBe(200);
      expect(runtime.repository[method]).toHaveBeenCalled();
    }

    vi.mocked(runtime.repository.requestRevision).mockRejectedValueOnce(
      new KnowledgeDraftVersionConflictError(),
    );
    expect((await app.inject({
      method: "POST",
      url: "/internal/knowledge-drafts/draft-1/request-revision",
      headers: authorization,
      payload: transitionPayload(),
    })).statusCode).toBe(409);

    vi.mocked(runtime.repository.reviseDraft).mockRejectedValueOnce(
      new KnowledgeDraftEvidenceError("document_permission_unavailable"),
    );
    const evidenceConflict = await app.inject({
      method: "POST",
      url: "/internal/knowledge-drafts/draft-1/revisions",
      headers: authorization,
      payload: revisePayload(),
    });
    expect(evidenceConflict.statusCode).toBe(409);
    expect(evidenceConflict.json()).toEqual({
      ok: false,
      error: "knowledge_draft_evidence_invalid",
      reason: "document_permission_unavailable",
    });
    await app.close();
  });

  it("rejects malformed values and exposes no Phase 5B route", async () => {
    const app = createApp(runtimeFixture());
    for (const request of [
      { method: "POST" as const, url: "/internal/knowledge-drafts", payload: { ...createPayload(), id: " " } },
      { method: "GET" as const, url: "/internal/knowledge-drafts?limit=0" },
      { method: "GET" as const, url: "/internal/knowledge-drafts?status=published,published" },
      { method: "POST" as const, url: "/internal/knowledge-drafts/draft-1/reject", payload: { expectedVersion: 0 } },
    ]) expect((await app.inject({ ...request, headers: authorization })).statusCode).toBe(400);

    for (const action of ["confirm", "approve", "publish", "send", "write"]) {
      expect((await app.inject({
        method: "POST",
        url: `/internal/knowledge-drafts/draft-1/${action}`,
        headers: authorization,
        payload: {},
      })).statusCode, action).toBe(404);
    }
    await app.close();
  });
});

function createApp(runtime: KnowledgeDraftRuntime) {
  return buildApp({
    ...disabledRuntimeFactories(),
    internalApiToken: "operator-secret",
    createKnowledgeDraftRuntime: () => runtime,
  });
}

function disabledRuntimeFactories() {
  return {
    createAnswerDraftRuntime: () => undefined,
    createMemoryExtractionRuntime: () => undefined,
    createEventWorkerRuntime: () => undefined,
    createDocumentSyncRuntime: () => undefined,
    createReindexWorkerRuntime: () => undefined,
    createConversationStateInspectionRuntime: () => undefined,
  };
}

function runtimeFixture(): KnowledgeDraftRuntime {
  const result = { outcome: "applied" as const, draft: draft() };
  return {
    repository: {
      createDraft: vi.fn(async () => result),
      reviseDraft: vi.fn(async () => result),
      requestRevision: vi.fn(async () => result),
      rejectDraft: vi.fn(async () => result),
      getDraft: vi.fn(async () => draft()),
      listDrafts: vi.fn(async () => []),
      listEvents: vi.fn(async () => []),
      getStatusCounts: vi.fn(async () => counts()),
    },
    canCreateDraft: vi.fn(() => true),
    getStatus: vi.fn(async () => ({
      enabled: true as const,
      companyCreationEnabled: true,
      counts: counts(),
    })),
    close: vi.fn(async () => undefined),
  };
}

function createPayload() {
  return {
    id: "draft-1",
    operationKey: "create-1",
    originKind: "group_conclusion",
    createdBy: "iris",
    revision: {
      sourceGroupId: "group-1",
      title: "Release checklist",
      content: "Run acceptance.",
      riskLevel: "medium",
      evidence: [
        { type: "conversation_message", id: "feishu:om_1", groupId: "group-1" },
        {
          type: "document_source",
          id: "source-1",
          expectedUpdatedAt: "2026-07-18T04:00:00.000Z",
        },
      ],
    },
  };
}

function revisePayload() {
  return {
    expectedVersion: 1,
    operationKey: "revise-1",
    actor: "operator",
    revision: createPayload().revision,
  };
}

function transitionPayload() {
  return {
    expectedVersion: 1,
    operationKey: "transition-1",
    actor: "operator",
    reason: "needs work",
  };
}

function counts() {
  return {
    pending_confirmation: 1,
    pending_review: 0,
    needs_revision: 0,
    rejected: 0,
    published: 0,
  };
}

function draft() {
  const createdAt = new Date("2026-07-18T05:00:00.000Z");
  return {
    id: "draft-1",
    sourceGroupId: "group-1",
    originKind: "group_conclusion" as const,
    status: "pending_confirmation" as const,
    currentRevisionNumber: 1,
    version: 1,
    createdBy: "iris",
    createdAt,
    updatedAt: createdAt,
    currentRevision: {
      revisionNumber: 1,
      riskLevel: "medium" as const,
      author: "iris",
      createdAt,
      evidenceState: { status: "current" as const },
      title: "Release checklist",
      content: "Run acceptance.",
      evidence: [],
    },
  };
}

function redactedDraft() {
  return {
    ...draft(),
    currentRevision: {
      revisionNumber: 1,
      riskLevel: "medium" as const,
      author: "iris",
      createdAt: new Date("2026-07-18T05:00:00.000Z"),
      evidenceState: {
        status: "invalidated" as const,
        reason: "document_permission_unavailable" as const,
      },
    },
  };
}

function event() {
  return {
    id: "event-1",
    draftId: "draft-1",
    eventType: "created" as const,
    toVersion: 1,
    operationKey: "create-1",
    actor: "iris",
    revisionNumber: 1,
    createdAt: new Date("2026-07-18T05:00:00.000Z"),
  };
}
