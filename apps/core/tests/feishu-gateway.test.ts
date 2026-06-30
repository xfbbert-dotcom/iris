import { describe, expect, it } from "vitest";
import { createFeishuGateway } from "../src/feishu/feishu-gateway.js";
import { InMemoryEventQueue } from "../src/queues/in-memory-event-queue.js";

describe("InMemoryEventQueue", () => {
  it("stores raw Feishu events with idempotency keys", async () => {
    const queue = new InMemoryEventQueue();

    await queue.enqueueRawFeishuEvent({
      idempotencyKey: "event-1",
      receivedAt: new Date("2026-06-30T00:00:00.000Z"),
      body: { event_id: "event-1", message: { chat_id: "chat-a" } }
    });

    expect(queue.events).toHaveLength(1);
    expect(queue.events[0]?.idempotencyKey).toBe("event-1");
  });

  it("deduplicates events by idempotency key", async () => {
    const queue = new InMemoryEventQueue();
    const firstEvent = {
      idempotencyKey: "event-1",
      receivedAt: new Date("2026-06-30T00:00:00.000Z"),
      body: { event_id: "event-1" }
    };
    const duplicateEvent = {
      idempotencyKey: "event-1",
      receivedAt: new Date("2026-06-30T00:00:01.000Z"),
      body: { event_id: "event-1", retry: true }
    };

    await queue.enqueueRawFeishuEvent(firstEvent);
    await queue.enqueueRawFeishuEvent(duplicateEvent);

    expect(queue.events).toHaveLength(1);
  });
});

describe("FeishuGateway", () => {
  it("returns HTTP 200 payload immediately after enqueueing", async () => {
    const queue = new InMemoryEventQueue();
    const gateway = createFeishuGateway({ queue });

    const response = await gateway.handleCallback({
      headers: { "x-iris-event-id": "event-1" },
      body: { event_id: "event-1", message: { chat_id: "chat-a" } }
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({ ok: true });
    expect(queue.events).toHaveLength(1);
  });

  it("does not run signal filtering before acknowledging", async () => {
    const queue = new InMemoryEventQueue();
    let signalFilterCalled = false;
    const gateway = createFeishuGateway({
      queue,
      signalFilter: async () => {
        signalFilterCalled = true;
      }
    });

    await gateway.handleCallback({
      headers: { "x-iris-event-id": "event-2" },
      body: { event_id: "event-2", message: { chat_id: "chat-a" } }
    });

    expect(signalFilterCalled).toBe(false);
  });
});
