import { describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { InMemoryEventQueue } from "../src/queues/in-memory-event-queue.js";

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
