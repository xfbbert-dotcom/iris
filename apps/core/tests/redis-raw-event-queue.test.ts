import { describe, expect, it, vi } from "vitest";

import {
  createRawEventIdempotencyKey,
  type RawEvent,
} from "../src/events/raw-event-queue.js";
import {
  createRedisRawEventQueue,
  parseRawEvent,
  serializeRawEvent,
  type RedisRawEventQueueClient,
} from "../src/events/redis-raw-event-queue.js";

describe("RedisRawEventQueue", () => {
  it("atomically enqueues raw events through Redis eval", async () => {
    const client: RedisRawEventQueueClient = {
      eval: vi.fn(async () => 1),
      rPush: vi.fn(),
      lPop: vi.fn(),
      lLen: vi.fn(),
    };
    const queue = createRedisRawEventQueue({ client });
    const event = eventFixture();

    await queue.enqueue(event);

    expect(client.eval).toHaveBeenCalledWith(expect.stringContaining("SADD"), {
      keys: ["iris:events:raw:seen", "iris:events:raw:queue"],
      arguments: [event.idempotencyKey, serializeRawEvent(event)],
    });
  });

  it("round-trips raw event dates through JSON", () => {
    const event = eventFixture();

    expect(parseRawEvent(serializeRawEvent(event))).toEqual(event);
  });

  it("normalizes queued raw event ids when parsing Redis payloads", () => {
    expect(
      parseRawEvent(
        JSON.stringify({
          idempotencyKey: " raw-event:feishu:event-1 ",
          provider: "feishu",
          eventType: " im.message.receive_v1 ",
          rawBody: { event_id: "event-1" },
          receivedAt: "2026-07-02T01:00:00.000Z",
          attempts: 0,
        }),
      ),
    ).toEqual(eventFixture());
  });

  it("defaults missing attempts to zero for old payloads", () => {
    const legacyEvent = {
      idempotencyKey: "raw-event:feishu:event-1",
      provider: "feishu",
      eventType: "im.message.receive_v1",
      rawBody: { event_id: "event-1" },
      receivedAt: "2026-07-02T01:00:00.000Z",
    };

    expect(parseRawEvent(JSON.stringify(legacyEvent))).toEqual(eventFixture());
  });

  it("rejects raw event payloads without object raw bodies", () => {
    const validPayload = {
      idempotencyKey: "raw-event:feishu:event-1",
      provider: "feishu",
      eventType: "im.message.receive_v1",
      receivedAt: "2026-07-02T01:00:00.000Z",
      attempts: 0,
    };

    expect(() => parseRawEvent(JSON.stringify(validPayload))).toThrow(
      "Invalid raw event payload",
    );
    expect(() => parseRawEvent(JSON.stringify({ ...validPayload, rawBody: "not-object" }))).toThrow(
      "Invalid raw event payload",
    );
  });

  it("dequeues raw events in FIFO order up to limit", async () => {
    const first = eventFixture({ idempotencyKey: "raw-event:feishu:event-1" });
    const second = eventFixture({ idempotencyKey: "raw-event:feishu:event-2" });
    const client: RedisRawEventQueueClient = {
      eval: vi.fn(),
      rPush: vi.fn(),
      lLen: vi.fn(),
      lPop: vi
        .fn()
        .mockResolvedValueOnce(serializeRawEvent(first))
        .mockResolvedValueOnce(serializeRawEvent(second))
        .mockResolvedValueOnce(null),
    };
    const queue = createRedisRawEventQueue({ client });

    await expect(queue.dequeueBatch(10)).resolves.toEqual([first, second]);
  });

  it("treats non-finite dequeue limits as zero", async () => {
    const client: RedisRawEventQueueClient = {
      eval: vi.fn(),
      rPush: vi.fn(),
      lLen: vi.fn(),
      lPop: vi.fn(async () => null),
    };
    const queue = createRedisRawEventQueue({ client });

    await expect(queue.dequeueBatch(Number.POSITIVE_INFINITY)).resolves.toEqual([]);
    await expect(queue.dequeueBatch(Number.NaN)).resolves.toEqual([]);
    expect(client.lPop).not.toHaveBeenCalled();
  });

  it("dead-letters invalid queued payloads and continues dequeuing valid events", async () => {
    const valid = eventFixture({ idempotencyKey: "raw-event:feishu:event-valid" });
    const client: RedisRawEventQueueClient = {
      eval: vi.fn(),
      rPush: vi.fn(async () => 1),
      lLen: vi.fn(),
      lPop: vi
        .fn()
        .mockResolvedValueOnce("{")
        .mockResolvedValueOnce(serializeRawEvent(valid)),
    };
    const queue = createRedisRawEventQueue({
      client,
      now: () => new Date("2026-07-03T12:00:00.000Z"),
    });

    await expect(queue.dequeueBatch(2)).resolves.toEqual([valid]);
    expect(client.rPush).toHaveBeenCalledWith(
      "iris:events:raw:dlq",
      JSON.stringify({
        rawPayload: "{",
        errorMessage: "Invalid raw event JSON",
        failedAt: "2026-07-03T12:00:00.000Z",
      }),
    );
  });

  it("dead-letters raw event payloads with missing bodies and continues dequeuing", async () => {
    const valid = eventFixture({ idempotencyKey: "raw-event:feishu:event-valid" });
    const invalidPayload = JSON.stringify({
      idempotencyKey: "raw-event:feishu:event-missing-body",
      provider: "feishu",
      eventType: "im.message.receive_v1",
      receivedAt: "2026-07-02T01:00:00.000Z",
      attempts: 0,
    });
    const client: RedisRawEventQueueClient = {
      eval: vi.fn(),
      rPush: vi.fn(async () => 1),
      lLen: vi.fn(),
      lPop: vi
        .fn()
        .mockResolvedValueOnce(invalidPayload)
        .mockResolvedValueOnce(serializeRawEvent(valid)),
    };
    const queue = createRedisRawEventQueue({
      client,
      now: () => new Date("2026-07-03T12:05:00.000Z"),
    });

    await expect(queue.dequeueBatch(2)).resolves.toEqual([valid]);
    expect(client.rPush).toHaveBeenCalledWith(
      "iris:events:raw:dlq",
      JSON.stringify({
        rawPayload: invalidPayload,
        errorMessage: "Invalid raw event payload",
        failedAt: "2026-07-03T12:05:00.000Z",
      }),
    );
  });

  it("requeues failed raw events below max attempts", async () => {
    const client: RedisRawEventQueueClient = {
      eval: vi.fn(),
      rPush: vi.fn(async () => 1),
      lPop: vi.fn(),
      lLen: vi.fn(),
    };
    const queue = createRedisRawEventQueue({ client, maxAttempts: 3 });
    const event = eventFixture();

    await expect(
      queue.handleFailedEvent({ event, errorMessage: "processor failed" }),
    ).resolves.toEqual({ action: "requeued", attempts: 1 });
    expect(client.rPush).toHaveBeenCalledWith(
      "iris:events:raw:queue",
      serializeRawEvent({ ...event, attempts: 1 }),
    );
  });

  it("moves failed raw events to Redis DLQ at max attempts", async () => {
    const client: RedisRawEventQueueClient = {
      eval: vi.fn(),
      rPush: vi.fn(async () => 1),
      lPop: vi.fn(),
      lLen: vi.fn(async () => 5),
    };
    const queue = createRedisRawEventQueue({ client, maxAttempts: 3 });
    const event = eventFixture({ attempts: 2 });

    await expect(
      queue.handleFailedEvent({ event, errorMessage: "processor failed" }),
    ).resolves.toEqual({ action: "dead_lettered", attempts: 3 });
    expect(client.rPush).toHaveBeenCalledWith(
      "iris:events:raw:dlq",
      expect.stringContaining("processor failed"),
    );
    await expect(queue.getDeadLetterCount()).resolves.toBe(5);
  });
});

function eventFixture(overrides: Partial<RawEvent> = {}): RawEvent {
  return {
    idempotencyKey: createRawEventIdempotencyKey({
      provider: "feishu",
      eventId: "event-1",
    }),
    provider: "feishu",
    eventType: "im.message.receive_v1",
    rawBody: { event_id: "event-1" },
    receivedAt: new Date("2026-07-02T01:00:00.000Z"),
    attempts: 0,
    ...overrides,
  };
}
