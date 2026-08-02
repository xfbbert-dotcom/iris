import { describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import {
  createPostgresConversationStateInspectionStore,
  type ConversationStateInspectionStore,
} from "../src/conversation-state/conversation-state-api.js";

const authorization = { authorization: "Bearer operator-secret" };

describe("conversation state operator API", () => {
  it("requires the configured bearer token for all five routes", async () => {
    const store = createStore();
    const app = await createApp(store);

    for (const url of [
      "/internal/conversation-state/status",
      "/internal/conversation-state/groups/group-a/threads",
      "/internal/conversation-state/groups/group-a/actions",
      "/internal/conversation-state/threads/thread-a/events",
      "/internal/conversation-state/actions/action-a/events",
    ]) {
      const missing = await app.inject({ method: "GET", url });
      const wrong = await app.inject({
        method: "GET",
        url,
        headers: { authorization: "Bearer wrong" },
      });

      expect(missing.statusCode).toBe(401);
      expect(wrong.statusCode).toBe(401);
      expect(missing.json()).toEqual({ ok: false, error: "internal_api_unauthorized" });
    }

    expect(store.getStatus).not.toHaveBeenCalled();
    await app.close();
  });

  it("fails closed when bearer authentication is not configured", async () => {
    const store = createStore();
    const app = await buildApp({
      conversationStateInspectionStore: store,
      createAnswerDraftRuntime: () => undefined,
      createMemoryExtractionRuntime: () => undefined,
      createEventWorkerRuntime: () => undefined,
      createDocumentSyncRuntime: () => undefined,
      createReindexWorkerRuntime: () => undefined,
    });

    const response = await app.inject({
      method: "GET",
      url: "/internal/conversation-state/status",
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      ok: false,
      error: "conversation_state_api_auth_unavailable",
    });
    expect(store.getStatus).not.toHaveBeenCalled();
    await app.close();
  });

  it("exposes evidence deletion only to an authenticated named operator", async () => {
    const store = createStore();
    store.deleteMessageEvidence.mockResolvedValue({
      status: "deleted",
      affectedThreadCount: 1,
      affectedActionCount: 1,
      deletedMemoryCount: 2,
    });
    const app = await createApp(store);
    const url = "/internal/conversation-state/groups/group-a/messages/message-a/evidence";

    const unauthorized = await app.inject({
      method: "DELETE",
      url,
      headers: { "x-iris-operator": "privacy-reviewer" },
    });
    const unnamed = await app.inject({ method: "DELETE", url, headers: authorization });
    const deleted = await app.inject({
      method: "DELETE",
      url,
      headers: { ...authorization, "x-iris-operator": "privacy-reviewer" },
    });

    expect(unauthorized.statusCode).toBe(401);
    expect(unnamed.statusCode).toBe(400);
    expect(deleted.statusCode).toBe(200);
    expect(store.deleteMessageEvidence).toHaveBeenCalledOnce();
    expect(store.deleteMessageEvidence).toHaveBeenCalledWith({
      groupId: "group-a",
      messageId: "message-a",
      operatorHint: "privacy-reviewer",
    });
    expect(deleted.json()).toEqual({
      ok: true,
      status: "deleted",
      affectedThreadCount: 1,
      affectedActionCount: 1,
      deletedMemoryCount: 2,
    });
    await app.close();
  });

  it("lists current-group threads including candidates with bounded evidence IDs", async () => {
    const store = createStore();
    store.listThreads.mockResolvedValue([
      {
        id: "candidate-a",
        groupId: "group-a",
        title: "Launch decision",
        summary: "Waiting for confirmation",
        status: "candidate",
        confidence: 0.71,
        version: 1,
        firstEvidenceAt: new Date("2026-07-16T01:00:00.000Z"),
        lastActivityAt: new Date("2026-07-16T01:00:00.000Z"),
        createdAt: new Date("2026-07-16T01:00:00.000Z"),
        updatedAt: new Date("2026-07-16T01:00:00.000Z"),
        evidenceMessageIds: ["message-a"],
      },
    ]);
    const app = await createApp(store);

    const response = await app.inject({
      method: "GET",
      url: "/internal/conversation-state/groups/group-a/threads?limit=2",
      headers: authorization,
    });

    expect(response.statusCode).toBe(200);
    expect(store.listThreads).toHaveBeenCalledWith({ groupId: "group-a", limit: 2 });
    expect(response.json()).toEqual({
      ok: true,
      groupId: "group-a",
      threads: [
        expect.objectContaining({
          id: "candidate-a",
          groupId: "group-a",
          status: "candidate",
          version: 1,
          evidenceMessageIds: ["message-a"],
        }),
      ],
    });
    expect(JSON.stringify(response.json())).not.toContain("raw message text");
    await app.close();
  });

  it("lists only current-group actions and preserves entity versions and evidence IDs", async () => {
    const store = createStore();
    store.listActions.mockResolvedValue([
      {
        id: "action-a",
        groupId: "group-a",
        threadId: "thread-a",
        description: "Alice sends the rollout note",
        ownerRefType: "feishu_user",
        ownerRef: "ou_alice",
        status: "open",
        confidence: 0.93,
        version: 3,
        createdAt: new Date("2026-07-16T01:00:00.000Z"),
        updatedAt: new Date("2026-07-16T02:00:00.000Z"),
        evidenceMessageIds: ["message-a", "message-b"],
      },
    ]);
    const app = await createApp(store);

    const response = await app.inject({
      method: "GET",
      url: "/internal/conversation-state/groups/group-a/actions",
      headers: authorization,
    });

    expect(response.statusCode).toBe(200);
    expect(store.listActions).toHaveBeenCalledWith({ groupId: "group-a", limit: 20 });
    expect(response.json()).toEqual({
      ok: true,
      groupId: "group-a",
      actions: [expect.objectContaining({
        id: "action-a",
        groupId: "group-a",
        version: 3,
        evidenceMessageIds: ["message-a", "message-b"],
      })],
    });
    await app.close();
  });

  it("lists bounded thread and action event histories with evidence IDs", async () => {
    const store = createStore();
    store.listThreadEvents.mockResolvedValue([
      {
        id: "thread-event-a",
        threadId: "thread-a",
        groupId: "group-a",
        eventType: "corrected",
        fromVersion: 1,
        toVersion: 2,
        operationKey: "thread-correction",
        createdAt: new Date("2026-07-16T02:00:00.000Z"),
        evidenceMessageIds: ["message-correction"],
      },
    ]);
    store.listActionEvents.mockResolvedValue([
      {
        id: "action-event-a",
        actionItemId: "action-a",
        groupId: "group-a",
        eventType: "completed",
        fromVersion: 1,
        toVersion: 2,
        operationKey: "action-completion",
        createdAt: new Date("2026-07-16T03:00:00.000Z"),
        evidenceMessageIds: ["message-completion"],
      },
    ]);
    const app = await createApp(store);

    const threadResponse = await app.inject({
      method: "GET",
      url: "/internal/conversation-state/threads/thread-a/events?limit=7",
      headers: authorization,
    });
    const actionResponse = await app.inject({
      method: "GET",
      url: "/internal/conversation-state/actions/action-a/events",
      headers: authorization,
    });

    expect(store.listThreadEvents).toHaveBeenCalledWith({ threadId: "thread-a", limit: 7 });
    expect(store.listActionEvents).toHaveBeenCalledWith({ actionItemId: "action-a", limit: 50 });
    expect(threadResponse.json()).toEqual({
      ok: true,
      threadId: "thread-a",
      events: [expect.objectContaining({
        eventType: "corrected",
        fromVersion: 1,
        toVersion: 2,
        evidenceMessageIds: ["message-correction"],
      })],
    });
    expect(actionResponse.json()).toEqual({
      ok: true,
      actionId: "action-a",
      events: [expect.objectContaining({
        eventType: "completed",
        fromVersion: 1,
        toVersion: 2,
        evidenceMessageIds: ["message-completion"],
      })],
    });
    await app.close();
  });

  it("rejects unbounded group, entity, and limit inputs before querying", async () => {
    const store = createStore();
    const app = await createApp(store);
    const oversized = "x".repeat(513);

    for (const url of [
      "/internal/conversation-state/groups/%20/threads",
      "/internal/conversation-state/groups/group-a/threads?limit=0",
      "/internal/conversation-state/groups/group-a/actions?limit=101",
      "/internal/conversation-state/threads/thread-a/events?limit=1.5",
    ]) {
      const response = await app.inject({ method: "GET", url, headers: authorization });
      expect(response.statusCode, url).toBe(400);
      expect(response.json()).toEqual({ ok: false, error: "invalid_request" });
    }
    for (const url of [
      `/internal/conversation-state/groups/${oversized}/actions`,
      `/internal/conversation-state/actions/${oversized}/events`,
    ]) {
      const response = await app.inject({ method: "GET", url, headers: authorization });
      expect([400, 414], url).toContain(response.statusCode);
    }

    expect(store.listThreads).not.toHaveBeenCalled();
    expect(store.listActions).not.toHaveBeenCalled();
    expect(store.listThreadEvents).not.toHaveBeenCalled();
    expect(store.listActionEvents).not.toHaveBeenCalled();
    await app.close();
  });

  it("returns content-free status counts without entity or message content", async () => {
    const store = createStore();
    store.getStatus.mockResolvedValue({
      threads: { candidate: 1, open: 2, resolved: 3, merged: 4 },
      actions: { open: 5, completed: 6, cancelled: 7 },
      projectionRepairs: { pending: 0, processing: 0, completed: 8, failed: 0 },
    });
    const app = await createApp(store);

    const response = await app.inject({
      method: "GET",
      url: "/internal/conversation-state/status",
      headers: authorization,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      threads: { candidate: 1, open: 2, resolved: 3, merged: 4 },
      actions: { open: 5, completed: 6, cancelled: 7 },
      projectionRepairs: { pending: 0, processing: 0, completed: 8, failed: 0 },
    });
    const serialized = response.body;
    for (const forbidden of ["title", "summary", "description", "ownerRef", "message", "evidence"]) {
      expect(serialized.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
    await app.close();
  });

  it("uses group- and parent-scoped bounded SQL without selecting raw message text", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const store = createPostgresConversationStateInspectionStore({ dataSource: { query } });

    await store.listThreads({ groupId: "group-a", limit: 20 });
    await store.listActions({ groupId: "group-a", limit: 20 });
    await store.listThreadEvents({ threadId: "thread-a", limit: 50 });
    await store.listActionEvents({ actionItemId: "action-a", limit: 50 });

    expect(query).toHaveBeenNthCalledWith(1, expect.stringContaining("thread.group_id = $1"), [
      "group-a",
      20,
      ["candidate", "open", "resolved", "merged"],
    ]);
    expect(query).toHaveBeenNthCalledWith(2, expect.stringContaining("action.group_id = $1"), [
      "group-a",
      20,
      ["open", "completed", "cancelled"],
    ]);
    expect(query).toHaveBeenNthCalledWith(3, expect.stringContaining("event.thread_id = $1"), ["thread-a", 50]);
    expect(query).toHaveBeenNthCalledWith(4, expect.stringContaining("event.action_item_id = $1"), ["action-a", 50]);
    const sql = query.mock.calls.map(([statement]) => String(statement).toLowerCase()).join("\n");
    expect(sql).not.toContain("conversation_messages.text");
    expect(sql).not.toContain("message.text");
    expect(sql).toContain("conversation_message_id");
    expect(sql).toContain("status = any");
  });

  it("returns bounded generic failures without leaking database or message content", async () => {
    const store = createStore();
    store.listThreads.mockRejectedValue(new Error("raw message text SELECT failed at postgres.internal"));
    const app = await createApp(store);

    const response = await app.inject({
      method: "GET",
      url: "/internal/conversation-state/groups/group-a/threads",
      headers: authorization,
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      ok: false,
      error: "conversation_state_inspection_failed",
    });
    expect(response.body).not.toContain("raw message text");
    expect(response.body).not.toContain("postgres.internal");
    await app.close();
  });
});

async function createApp(store: ConversationStateInspectionStore) {
  return await buildApp({
    internalApiToken: "operator-secret",
    conversationStateInspectionStore: store,
    createAnswerDraftRuntime: () => undefined,
    createMemoryExtractionRuntime: () => undefined,
    createEventWorkerRuntime: () => undefined,
    createDocumentSyncRuntime: () => undefined,
    createReindexWorkerRuntime: () => undefined,
  });
}

function createStore() {
  return {
    getStatus: vi.fn<ConversationStateInspectionStore["getStatus"]>().mockResolvedValue({
      threads: { candidate: 0, open: 0, resolved: 0, merged: 0 },
      actions: { open: 0, completed: 0, cancelled: 0 },
      projectionRepairs: { pending: 0, processing: 0, completed: 0, failed: 0 },
    }),
    listThreads: vi.fn<ConversationStateInspectionStore["listThreads"]>().mockResolvedValue([]),
    listActions: vi.fn<ConversationStateInspectionStore["listActions"]>().mockResolvedValue([]),
    listThreadEvents: vi.fn<ConversationStateInspectionStore["listThreadEvents"]>().mockResolvedValue([]),
    listActionEvents: vi.fn<ConversationStateInspectionStore["listActionEvents"]>().mockResolvedValue([]),
    deleteMessageEvidence: vi.fn().mockResolvedValue({ status: "not_found" }),
  };
}
