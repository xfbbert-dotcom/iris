import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
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

  it("returns 401 and does not enqueue when verifier returns false", async () => {
    const queue = new InMemoryEventQueue();
    const gateway = createFeishuGateway({
      queue,
      verifyRequest: () => false
    });

    const response = await gateway.handleCallback({
      headers: { "x-iris-event-id": "event-invalid" },
      body: { event_id: "event-invalid" }
    });

    expect(response.statusCode).toBe(401);
    expect(response.body).toEqual({ ok: false });
    expect(queue.events).toHaveLength(0);
  });

  it("returns 401 and does not enqueue when verifier throws", async () => {
    const queue = new InMemoryEventQueue();
    const gateway = createFeishuGateway({
      queue,
      verifyRequest: () => {
        throw new Error("invalid signature");
      }
    });

    const response = await gateway.handleCallback({
      headers: { "x-iris-event-id": "event-throwing-verifier" },
      body: { event_id: "event-throwing-verifier" }
    });

    expect(response.statusCode).toBe(401);
    expect(response.body).toEqual({ ok: false });
    expect(queue.events).toHaveLength(0);
  });

  it("uses the header key before body event_id", async () => {
    const queue = new InMemoryEventQueue();
    const gateway = createFeishuGateway({ queue });

    await gateway.handleCallback({
      headers: { "x-iris-event-id": " header-event " },
      body: { event_id: "body-event" }
    });

    expect(queue.events[0]?.idempotencyKey).toBe("header-event");
  });

  it("uses body event_id when the header is missing", async () => {
    const queue = new InMemoryEventQueue();
    const gateway = createFeishuGateway({ queue });

    await gateway.handleCallback({
      headers: {},
      body: { event_id: " body-event " }
    });

    expect(queue.events[0]?.idempotencyKey).toBe("body-event");
  });

  it("ignores a whitespace header and uses body event_id", async () => {
    const queue = new InMemoryEventQueue();
    const gateway = createFeishuGateway({ queue });

    await gateway.handleCallback({
      headers: { "x-iris-event-id": "   " },
      body: { event_id: "body-event" }
    });

    expect(queue.events[0]?.idempotencyKey).toBe("body-event");
  });

  it("falls back to a generated key when body event_id is blank", async () => {
    const queue = new InMemoryEventQueue();
    const gateway = createFeishuGateway({ queue });

    await gateway.handleCallback({
      headers: {},
      body: { event_id: "   " }
    });

    expect(queue.events[0]?.idempotencyKey).not.toBe("");
    expect(queue.events[0]?.idempotencyKey).not.toBe("   ");
  });
});

describe("Core App Feishu route", () => {
  it("returns 200 from the Feishu callback route", async () => {
    const queue = new InMemoryEventQueue();
    const app = buildApp({ queue });

    const response = await app.inject({
      method: "POST",
      url: "/feishu/events",
      headers: { "x-iris-event-id": "event-route-1" },
      payload: { event_id: "event-route-1" }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    expect(queue.events).toHaveLength(1);
  });

  it("returns 401 and does not enqueue when the Feishu verifier rejects", async () => {
    const queue = new InMemoryEventQueue();
    const app = buildApp({
      queue,
      verifyFeishuRequest: () => false
    });

    const response = await app.inject({
      method: "POST",
      url: "/feishu/events",
      headers: { "x-iris-event-id": "event-route-invalid" },
      payload: { event_id: "event-route-invalid" }
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ ok: false });
    expect(queue.events).toHaveLength(0);
  });

  it("returns 400 and skips Feishu handling when JSON is malformed", async () => {
    const queue = new InMemoryEventQueue();
    let verifierCalled = false;
    const app = buildApp({
      queue,
      verifyFeishuRequest: () => {
        verifierCalled = true;
        return true;
      }
    });

    const response = await app.inject({
      method: "POST",
      url: "/feishu/events",
      headers: { "content-type": "application/json" },
      payload: "{\"event_id\":"
    });

    expect(response.statusCode).toBe(400);
    expect(verifierCalled).toBe(false);
    expect(queue.events).toHaveLength(0);
  });

  it("passes the raw JSON body to the Feishu verifier", async () => {
    const queue = new InMemoryEventQueue();
    let observedRawBody: string | undefined;
    const app = buildApp({
      queue,
      verifyFeishuRequest: (request) => {
        observedRawBody = request.rawBody;
        return true;
      }
    });

    await app.inject({
      method: "POST",
      url: "/feishu/events",
      payload: { event_id: "raw-body-1" }
    });

    expect(observedRawBody).toBe(JSON.stringify({ event_id: "raw-body-1" }));
  });

  it("uses Feishu auth config from the environment when no verifier is injected", async () => {
    const originalVerificationToken = process.env.FEISHU_VERIFICATION_TOKEN;
    const originalEncryptKey = process.env.FEISHU_ENCRYPT_KEY;
    process.env.FEISHU_VERIFICATION_TOKEN = "token-a";
    delete process.env.FEISHU_ENCRYPT_KEY;

    try {
      const queue = new InMemoryEventQueue();
      const app = buildApp({ queue });

      const rejectedResponse = await app.inject({
        method: "POST",
        url: "/feishu/events",
        headers: { "x-iris-event-id": "event-route-env-invalid" },
        payload: {
          event_id: "event-route-env-invalid",
          header: { token: "wrong-token" }
        }
      });

      expect(rejectedResponse.statusCode).toBe(401);
      expect(rejectedResponse.json()).toEqual({ ok: false });
      expect(queue.events).toHaveLength(0);

      const acceptedResponse = await app.inject({
        method: "POST",
        url: "/feishu/events",
        headers: { "x-iris-event-id": "event-route-env-valid" },
        payload: {
          event_id: "event-route-env-valid",
          header: { token: "token-a" }
        }
      });

      expect(acceptedResponse.statusCode).toBe(200);
      expect(acceptedResponse.json()).toEqual({ ok: true });
      expect(queue.events).toHaveLength(1);
    } finally {
      restoreEnv("FEISHU_VERIFICATION_TOKEN", originalVerificationToken);
      restoreEnv("FEISHU_ENCRYPT_KEY", originalEncryptKey);
    }
  });
});

function restoreEnv(name: "FEISHU_VERIFICATION_TOKEN" | "FEISHU_ENCRYPT_KEY", value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
    return;
  }

  process.env[name] = value;
}
