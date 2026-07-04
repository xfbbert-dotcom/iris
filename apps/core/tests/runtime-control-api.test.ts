import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import { InMemoryAuditLog, type AuditEvent } from "../src/audit/audit-log.js";
import { InMemoryEventQueue } from "../src/queues/in-memory-event-queue.js";
import { isolateEnvVar } from "./test-env.js";

let restoreInternalApiToken: () => void = () => undefined;

beforeEach(() => {
  restoreInternalApiToken = isolateEnvVar("IRIS_INTERNAL_API_TOKEN");
});

afterEach(() => {
  restoreInternalApiToken();
});

describe("runtime control API", () => {
  it("returns runtime control status", async () => {
    const app = buildApp({
      createAnswerDraftRuntime: () => undefined,
      createEventWorkerRuntime: () => undefined,
      createDocumentSyncRuntime: () => undefined,
      createReindexWorkerRuntime: () => undefined,
    });

    const response = await app.inject({
      method: "GET",
      url: "/internal/runtime-control/status",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      globalEnabled: true,
      disabledGroupIds: [],
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
    });
  });

  it("globally disables and re-enables Feishu event ingestion", async () => {
    const queue = new InMemoryEventQueue();
    const app = buildApp({
      queue,
      createAnswerDraftRuntime: () => undefined,
      createEventWorkerRuntime: () => undefined,
      createDocumentSyncRuntime: () => undefined,
      createReindexWorkerRuntime: () => undefined,
    });

    const disableResponse = await app.inject({
      method: "POST",
      url: "/internal/runtime-control/global",
      payload: { enabled: false },
    });

    expect(disableResponse.statusCode).toBe(200);
    expect(disableResponse.json()).toMatchObject({
      ok: true,
      globalEnabled: false,
    });

    const disabledCallback = await app.inject({
      method: "POST",
      url: "/feishu/events",
      payload: feishuMessagePayload("event-disabled", "chat-a"),
    });

    expect(disabledCallback.statusCode).toBe(200);
    expect(disabledCallback.json()).toEqual({ ok: true });
    expect(queue.events).toEqual([]);

    const enableResponse = await app.inject({
      method: "POST",
      url: "/internal/runtime-control/global",
      payload: { enabled: true },
    });

    expect(enableResponse.statusCode).toBe(200);
    expect(enableResponse.json()).toMatchObject({
      ok: true,
      globalEnabled: true,
    });

    await app.inject({
      method: "POST",
      url: "/feishu/events",
      payload: feishuMessagePayload("event-enabled", "chat-a"),
    });

    expect(queue.events).toHaveLength(1);
    expect(queue.events[0]?.idempotencyKey).toBe("event-enabled");
  });

  it("surfaces global runtime disablement in consolidated status", async () => {
    const app = buildApp({
      createAnswerDraftRuntime: () => undefined,
      createEventWorkerRuntime: () => undefined,
      createDocumentSyncRuntime: () => undefined,
      createReindexWorkerRuntime: () => undefined,
    });

    await app.inject({
      method: "POST",
      url: "/internal/runtime-control/global",
      payload: { enabled: false },
    });

    const status = await app.inject({
      method: "GET",
      url: "/internal/status",
    });

    expect(status.statusCode).toBe(200);
    expect(status.json().components.runtimeControl).toEqual({
      status: "disabled",
      ok: true,
      enabled: false,
      globalEnabled: false,
      disabledGroupIds: [],
      disabledGroupCount: 0,
    });
    expect(status.json().summary.attentionComponents).toContainEqual({
      name: "runtimeControl",
      status: "disabled",
    });
  });

  it("disables and re-enables Feishu event ingestion for one group", async () => {
    const queue = new InMemoryEventQueue();
    const app = buildApp({
      queue,
      createAnswerDraftRuntime: () => undefined,
      createEventWorkerRuntime: () => undefined,
      createDocumentSyncRuntime: () => undefined,
      createReindexWorkerRuntime: () => undefined,
    });

    const disableResponse = await app.inject({
      method: "POST",
      url: "/internal/runtime-control/groups/%20chat-a%20",
      payload: { enabled: false },
    });

    expect(disableResponse.statusCode).toBe(200);
    expect(disableResponse.json()).toMatchObject({
      ok: true,
      disabledGroupIds: ["chat-a"],
    });

    await app.inject({
      method: "POST",
      url: "/feishu/events",
      payload: feishuMessagePayload("event-disabled-group", "chat-a"),
    });
    await app.inject({
      method: "POST",
      url: "/feishu/events",
      payload: feishuMessagePayload("event-enabled-group", "chat-b"),
    });

    expect(queue.events).toHaveLength(1);
    expect(queue.events[0]?.idempotencyKey).toBe("event-enabled-group");

    const enableResponse = await app.inject({
      method: "POST",
      url: "/internal/runtime-control/groups/chat-a",
      payload: { enabled: true },
    });

    expect(enableResponse.statusCode).toBe(200);
    expect(enableResponse.json()).toMatchObject({
      ok: true,
      disabledGroupIds: [],
    });

    await app.inject({
      method: "POST",
      url: "/feishu/events",
      payload: feishuMessagePayload("event-reenabled-group", "chat-a"),
    });

    expect(queue.events).toHaveLength(2);
    expect(queue.events[1]?.idempotencyKey).toBe("event-reenabled-group");
  });

  it("rejects invalid runtime control requests", async () => {
    const app = buildApp({
      createAnswerDraftRuntime: () => undefined,
      createEventWorkerRuntime: () => undefined,
      createDocumentSyncRuntime: () => undefined,
      createReindexWorkerRuntime: () => undefined,
    });

    const invalidGlobal = await app.inject({
      method: "POST",
      url: "/internal/runtime-control/global",
      payload: { enabled: "false" },
    });
    const invalidGroup = await app.inject({
      method: "POST",
      url: "/internal/runtime-control/groups/%20",
      payload: { enabled: true },
    });

    expect(invalidGlobal.statusCode).toBe(400);
    expect(invalidGlobal.json()).toEqual({ ok: false, error: "invalid_request" });
    expect(invalidGroup.statusCode).toBe(400);
    expect(invalidGroup.json()).toEqual({ ok: false, error: "invalid_request" });
  });

  it("blocks answer draft generation while Iris is globally disabled", async () => {
    const answerDraftOrchestrator = {
      generateDraft: vi.fn(async () => ({
        answerText: "Draft answer.",
        promptContext: "",
        allowedFragments: [],
        deniedDocumentIds: [],
        retrievedFragmentCount: 0,
      })),
    };
    const app = buildApp({
      answerDraftOrchestrator,
      createEventWorkerRuntime: () => undefined,
      createDocumentSyncRuntime: () => undefined,
      createReindexWorkerRuntime: () => undefined,
    });

    await app.inject({
      method: "POST",
      url: "/internal/runtime-control/global",
      payload: { enabled: false },
    });

    const response = await app.inject({
      method: "POST",
      url: "/internal/answer-drafts",
      payload: {
        question: "What changed?",
        liveChatMessages: [],
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ ok: false, error: "iris_runtime_disabled" });
    expect(answerDraftOrchestrator.generateDraft).not.toHaveBeenCalled();
  });

  it("blocks answer draft generation for disabled groups only", async () => {
    const answerDraftOrchestrator = {
      generateDraft: vi.fn(async () => ({
        answerText: "Draft answer.",
        promptContext: "",
        allowedFragments: [],
        deniedDocumentIds: [],
        retrievedFragmentCount: 0,
      })),
    };
    const app = buildApp({
      answerDraftOrchestrator,
      createEventWorkerRuntime: () => undefined,
      createDocumentSyncRuntime: () => undefined,
      createReindexWorkerRuntime: () => undefined,
    });

    await app.inject({
      method: "POST",
      url: "/internal/runtime-control/groups/chat-a",
      payload: { enabled: false },
    });

    const disabledResponse = await app.inject({
      method: "POST",
      url: "/internal/answer-drafts",
      payload: {
        question: "What changed?",
        chatId: "chat-a",
        liveChatMessages: [],
      },
    });
    const enabledResponse = await app.inject({
      method: "POST",
      url: "/internal/answer-drafts",
      payload: {
        question: "What changed?",
        chatId: "chat-b",
        liveChatMessages: [],
      },
    });

    expect(disabledResponse.statusCode).toBe(403);
    expect(disabledResponse.json()).toEqual({ ok: false, error: "iris_runtime_disabled" });
    expect(enabledResponse.statusCode).toBe(200);
    expect(enabledResponse.json()).toMatchObject({ answerText: "Draft answer." });
    expect(answerDraftOrchestrator.generateDraft).toHaveBeenCalledTimes(1);
    expect(answerDraftOrchestrator.generateDraft).toHaveBeenCalledWith({
      question: "What changed?",
      chatId: "chat-b",
      liveChatMessages: [],
    });
  });

  it("updates runtime capabilities", async () => {
    const app = buildApp({
      createAnswerDraftRuntime: () => undefined,
      createEventWorkerRuntime: () => undefined,
      createDocumentSyncRuntime: () => undefined,
      createReindexWorkerRuntime: () => undefined,
    });

    const response = await app.inject({
      method: "PATCH",
      url: "/internal/runtime-control/capabilities",
      payload: {
        proactiveSpeech: false,
        writeKnowledgeBase: true,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      capabilities: {
        proactiveSpeech: false,
        writeKnowledgeBase: true,
      },
    });

    const status = await app.inject({
      method: "GET",
      url: "/internal/runtime-control/status",
    });

    expect(status.json()).toMatchObject({
      capabilities: {
        proactiveSpeech: false,
        writeKnowledgeBase: true,
      },
    });
  });

  it("records successful runtime control changes in the audit log", async () => {
    const recordedAt = new Date("2026-07-04T06:20:00.000Z");
    const auditLog = new InMemoryAuditLog({ now: () => recordedAt });
    const app = buildApp({
      auditLog,
      createAnswerDraftRuntime: () => undefined,
      createEventWorkerRuntime: () => undefined,
      createDocumentSyncRuntime: () => undefined,
      createReindexWorkerRuntime: () => undefined,
    });

    await app.inject({
      method: "POST",
      url: "/internal/runtime-control/global",
      payload: { enabled: false },
    });
    await app.inject({
      method: "POST",
      url: "/internal/runtime-control/groups/chat-a",
      payload: { enabled: false },
    });
    await app.inject({
      method: "PATCH",
      url: "/internal/runtime-control/capabilities",
      payload: {
        proactiveSpeech: false,
        writeKnowledgeBase: true,
      },
    });

    const events = await app.inject({
      method: "GET",
      url: "/internal/audit/events?limit=20&type=runtime_control_updated",
    });

    expect(events.statusCode).toBe(200);
    expect(events.json().events).toEqual([
      {
        type: "runtime_control_updated",
        documentId: "runtime-control",
        fragmentIds: [],
        runtimeControlScope: "capability",
        targetId: "writeKnowledgeBase",
        enabled: true,
        previousEnabled: false,
        recordedAt: "2026-07-04T06:20:00.000Z",
      },
      {
        type: "runtime_control_updated",
        documentId: "runtime-control",
        fragmentIds: [],
        runtimeControlScope: "capability",
        targetId: "proactiveSpeech",
        enabled: false,
        previousEnabled: true,
        recordedAt: "2026-07-04T06:20:00.000Z",
      },
      {
        type: "runtime_control_updated",
        documentId: "runtime-control",
        fragmentIds: [],
        runtimeControlScope: "group",
        targetId: "chat-a",
        enabled: false,
        previousEnabled: true,
        recordedAt: "2026-07-04T06:20:00.000Z",
      },
      {
        type: "runtime_control_updated",
        documentId: "runtime-control",
        fragmentIds: [],
        runtimeControlScope: "global",
        enabled: false,
        previousEnabled: true,
        recordedAt: "2026-07-04T06:20:00.000Z",
      },
    ]);
  });

  it("keeps runtime control mutations available when audit logging fails", async () => {
    class FailingAuditLog extends InMemoryAuditLog {
      override async record(_event: AuditEvent): Promise<void> {
        throw new Error("audit sink unavailable");
      }
    }

    const app = buildApp({
      auditLog: new FailingAuditLog(),
      createAnswerDraftRuntime: () => undefined,
      createEventWorkerRuntime: () => undefined,
      createDocumentSyncRuntime: () => undefined,
      createReindexWorkerRuntime: () => undefined,
    });

    const response = await app.inject({
      method: "POST",
      url: "/internal/runtime-control/global",
      payload: { enabled: false },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      globalEnabled: false,
    });
  });

  it("rejects invalid runtime capability updates", async () => {
    const app = buildApp({
      createAnswerDraftRuntime: () => undefined,
      createEventWorkerRuntime: () => undefined,
      createDocumentSyncRuntime: () => undefined,
      createReindexWorkerRuntime: () => undefined,
    });

    const unknownCapability = await app.inject({
      method: "PATCH",
      url: "/internal/runtime-control/capabilities",
      payload: { unknownCapability: true },
    });
    const nonBooleanCapability = await app.inject({
      method: "PATCH",
      url: "/internal/runtime-control/capabilities",
      payload: { proactiveSpeech: "false" },
    });
    const emptyUpdate = await app.inject({
      method: "PATCH",
      url: "/internal/runtime-control/capabilities",
      payload: {},
    });

    expect(unknownCapability.statusCode).toBe(400);
    expect(unknownCapability.json()).toEqual({ ok: false, error: "invalid_request" });
    expect(nonBooleanCapability.statusCode).toBe(400);
    expect(nonBooleanCapability.json()).toEqual({ ok: false, error: "invalid_request" });
    expect(emptyUpdate.statusCode).toBe(400);
    expect(emptyUpdate.json()).toEqual({ ok: false, error: "invalid_request" });
  });

  it("blocks answer draft generation when reply capability is disabled", async () => {
    const answerDraftOrchestrator = {
      generateDraft: vi.fn(async () => ({
        answerText: "Draft answer.",
        promptContext: "",
        allowedFragments: [],
        deniedDocumentIds: [],
        retrievedFragmentCount: 0,
      })),
    };
    const app = buildApp({
      answerDraftOrchestrator,
      createEventWorkerRuntime: () => undefined,
      createDocumentSyncRuntime: () => undefined,
      createReindexWorkerRuntime: () => undefined,
    });

    await app.inject({
      method: "PATCH",
      url: "/internal/runtime-control/capabilities",
      payload: { replyWhenMentioned: false },
    });

    const response = await app.inject({
      method: "POST",
      url: "/internal/answer-drafts",
      payload: {
        question: "What changed?",
        chatId: "chat-a",
        liveChatMessages: [],
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ ok: false, error: "iris_runtime_disabled" });
    expect(answerDraftOrchestrator.generateDraft).not.toHaveBeenCalled();
  });
});

function feishuMessagePayload(eventId: string, chatId: string) {
  return {
    header: {
      event_id: eventId,
      event_type: "im.message.receive_v1",
    },
    event: {
      message: {
        message_id: `${eventId}-message`,
        chat_id: chatId,
        message_type: "text",
        content: "{\"text\":\"hello\"}",
      },
    },
  };
}
