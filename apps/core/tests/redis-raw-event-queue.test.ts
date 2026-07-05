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
      lRange: vi.fn(),
      lRem: vi.fn(),
      sRem: vi.fn(),
    };
    const queue = createRedisRawEventQueue({ client });
    const event = eventFixture();

    await queue.enqueue(event);

    expect(client.eval).toHaveBeenCalledWith(expect.stringContaining("SADD"), {
      keys: ["iris:events:raw:seen", "iris:events:raw:queue"],
      arguments: [event.idempotencyKey, serializeRawEvent(event)],
    });
  });

  it("normalizes raw events before Redis enqueue and retry upserts", async () => {
    const client: RedisRawEventQueueClient = {
      eval: vi.fn(async () => 1),
      rPush: vi.fn(async () => 1),
      lPop: vi.fn(),
      lLen: vi.fn(),
      lRange: vi.fn(),
      lRem: vi.fn(),
      sRem: vi.fn(),
    };
    const queue = createRedisRawEventQueue({ client, maxAttempts: 3 });
    const event = eventFixture({
      idempotencyKey: " raw-event:feishu:event-1 ",
      eventType: " im.message.receive_v1 ",
    });

    await queue.enqueue(event);
    await queue.handleFailedEvent({ event, errorMessage: "processor failed" });

    expect(client.eval).toHaveBeenNthCalledWith(1, expect.stringContaining("SADD"), {
      keys: ["iris:events:raw:seen", "iris:events:raw:queue"],
      arguments: [eventFixture().idempotencyKey, serializeRawEvent(eventFixture())],
    });
    expect(client.eval).toHaveBeenNthCalledWith(2, expect.stringContaining("SADD"), {
      keys: ["iris:events:raw:seen", "iris:events:raw:queue"],
      arguments: [
        eventFixture().idempotencyKey,
        serializeRawEvent({ ...eventFixture(), attempts: 1 }),
      ],
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

  it("rejects unsafe integer raw event attempts", () => {
    expect(() =>
      parseRawEvent(
        JSON.stringify({
          idempotencyKey: "raw-event:feishu:event-1",
          provider: "feishu",
          eventType: "im.message.receive_v1",
          rawBody: { event_id: "event-1" },
          receivedAt: "2026-07-02T01:00:00.000Z",
          attempts: 9007199254740992,
        }),
      ),
    ).toThrow("Invalid raw event payload");
  });

  it("rejects oversized queued raw event identifiers", () => {
    const validPayload = {
      ...eventFixture(),
      receivedAt: "2026-07-02T01:00:00.000Z",
    };

    expect(() =>
      parseRawEvent(
        JSON.stringify({
          ...validPayload,
          idempotencyKey: `raw-event:feishu:${"e".repeat(513)}`,
        }),
      ),
    ).toThrow("Invalid raw event payload");
    expect(() =>
      parseRawEvent(
        JSON.stringify({
          ...validPayload,
          eventType: "t".repeat(513),
        }),
      ),
    ).toThrow("Invalid raw event payload");
  });

  it("dequeues raw events in FIFO order up to limit", async () => {
    const first = eventFixture({ idempotencyKey: "raw-event:feishu:event-1" });
    const second = eventFixture({ idempotencyKey: "raw-event:feishu:event-2" });
    const client: RedisRawEventQueueClient = {
      eval: vi.fn(),
      rPush: vi.fn(),
      lLen: vi.fn(),
      lRange: vi.fn(),
      lRem: vi.fn(),
      lPop: vi
        .fn()
        .mockResolvedValueOnce(serializeRawEvent(first))
        .mockResolvedValueOnce(serializeRawEvent(second))
        .mockResolvedValueOnce(null),
      sRem: vi.fn(async () => 1),
    };
    const queue = createRedisRawEventQueue({ client });

    await expect(queue.dequeueBatch(10)).resolves.toEqual([first, second]);
  });

  it("releases dequeued raw event idempotency keys from the Redis seen set", async () => {
    const event = eventFixture({ idempotencyKey: "raw-event:feishu:event-1" });
    const client = {
      eval: vi.fn(),
      rPush: vi.fn(),
      lLen: vi.fn(),
      lRange: vi.fn(),
      lRem: vi.fn(),
      lPop: vi.fn().mockResolvedValueOnce(serializeRawEvent(event)).mockResolvedValueOnce(null),
      sRem: vi.fn(async () => 1),
    };
    const queue = createRedisRawEventQueue({ client });

    await expect(queue.dequeueBatch(10)).resolves.toEqual([event]);

    expect(client.sRem).toHaveBeenCalledWith(
      "iris:events:raw:seen",
      event.idempotencyKey,
    );
  });

  it("rejects non-finite dequeue limits before popping Redis events", async () => {
    const client: RedisRawEventQueueClient = {
      eval: vi.fn(),
      rPush: vi.fn(),
      lLen: vi.fn(),
      lRange: vi.fn(),
      lRem: vi.fn(),
      lPop: vi.fn(async () => null),
      sRem: vi.fn(),
    };
    const queue = createRedisRawEventQueue({ client });

    await expect(queue.dequeueBatch(Number.POSITIVE_INFINITY)).rejects.toThrow(
      "raw event queue limit must be a finite safe-magnitude number",
    );
    await expect(queue.dequeueBatch(Number.NaN)).rejects.toThrow(
      "raw event queue limit must be a finite safe-magnitude number",
    );
    expect(client.lPop).not.toHaveBeenCalled();
  });

  it("caps oversized dequeue limits before popping Redis events", async () => {
    let nextEvent = 0;
    const client: RedisRawEventQueueClient = {
      eval: vi.fn(),
      rPush: vi.fn(),
      lLen: vi.fn(),
      lRange: vi.fn(),
      lRem: vi.fn(),
      lPop: vi.fn(async () => {
        const current = nextEvent;
        nextEvent += 1;
        return serializeRawEvent(
          eventFixture({ idempotencyKey: `raw-event:feishu:event-${current}` }),
        );
      }),
      sRem: vi.fn(async () => 1),
    };
    const queue = createRedisRawEventQueue({ client });

    await expect(queue.dequeueBatch(101)).resolves.toHaveLength(100);

    expect(client.lPop).toHaveBeenCalledTimes(100);
  });

  it("rejects unsafe dequeue limits before popping Redis events", async () => {
    const client: RedisRawEventQueueClient = {
      eval: vi.fn(),
      rPush: vi.fn(),
      lLen: vi.fn(),
      lRange: vi.fn(),
      lRem: vi.fn(),
      lPop: vi.fn(async () => null),
      sRem: vi.fn(),
    };
    const queue = createRedisRawEventQueue({ client });

    await expect(queue.dequeueBatch(Number.MAX_SAFE_INTEGER + 1)).rejects.toThrow(
      "raw event queue limit must be a finite safe-magnitude number",
    );
    expect(client.lPop).not.toHaveBeenCalled();
  });

  it("dead-letters invalid queued payloads and continues dequeuing valid events", async () => {
    const valid = eventFixture({ idempotencyKey: "raw-event:feishu:event-valid" });
    const client: RedisRawEventQueueClient = {
      eval: vi.fn(),
      rPush: vi.fn(async () => 1),
      lLen: vi.fn(),
      lRange: vi.fn(),
      lRem: vi.fn(),
      lPop: vi
        .fn()
        .mockResolvedValueOnce("{")
        .mockResolvedValueOnce(serializeRawEvent(valid)),
      sRem: vi.fn(async () => 1),
    };
    const queue = createRedisRawEventQueue({
      client,
      now: () => new Date("2026-07-03T12:00:00.000Z"),
      idGenerator: () => "dlq-invalid-json",
    });

    await expect(queue.dequeueBatch(2)).resolves.toEqual([valid]);
    expect(client.rPush).toHaveBeenCalledWith(
      "iris:events:raw:dlq",
      JSON.stringify({
        id: "dlq-invalid-json",
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
      lRange: vi.fn(),
      lRem: vi.fn(),
      lPop: vi
        .fn()
        .mockResolvedValueOnce(invalidPayload)
        .mockResolvedValueOnce(serializeRawEvent(valid)),
      sRem: vi.fn(async () => 1),
    };
    const queue = createRedisRawEventQueue({
      client,
      now: () => new Date("2026-07-03T12:05:00.000Z"),
      idGenerator: () => "dlq-invalid-payload",
    });

    await expect(queue.dequeueBatch(2)).resolves.toEqual([valid]);
    expect(client.rPush).toHaveBeenCalledWith(
      "iris:events:raw:dlq",
      JSON.stringify({
        id: "dlq-invalid-payload",
        rawPayload: invalidPayload,
        errorMessage: "Invalid raw event payload",
        failedAt: "2026-07-03T12:05:00.000Z",
      }),
    );
    expect(client.sRem).toHaveBeenCalledWith(
      "iris:events:raw:seen",
      "raw-event:feishu:event-missing-body",
    );
  });

  it("requeues failed raw events below max attempts", async () => {
    const client: RedisRawEventQueueClient = {
      eval: vi.fn(async () => 1),
      rPush: vi.fn(async () => 1),
      lPop: vi.fn(),
      lLen: vi.fn(),
      lRange: vi.fn(),
      lRem: vi.fn(),
      sRem: vi.fn(),
    };
    const queue = createRedisRawEventQueue({ client, maxAttempts: 3 });
    const event = eventFixture();

    await expect(
      queue.handleFailedEvent({ event, errorMessage: "processor failed" }),
    ).resolves.toEqual({ action: "requeued", attempts: 1 });
    expect(client.eval).toHaveBeenCalledWith(expect.stringContaining("SADD"), {
      keys: ["iris:events:raw:seen", "iris:events:raw:queue"],
      arguments: [event.idempotencyKey, serializeRawEvent({ ...event, attempts: 1 })],
    });
    expect(client.rPush).not.toHaveBeenCalled();
  });

  it("upgrades a pending duplicate when the in-flight raw event fails", async () => {
    const event = eventFixture();
    const state = {
      seen: new Set([event.idempotencyKey]),
      queue: [serializeRawEvent({ ...event, receivedAt: new Date("2026-07-02T02:00:00.000Z") })],
    };
    const client: RedisRawEventQueueClient = {
      eval: vi.fn(async (script, options) => {
        const [idempotencyKey, payload] = options.arguments;
        if (!state.seen.has(idempotencyKey)) {
          state.seen.add(idempotencyKey);
          state.queue.push(payload);
          return state.queue.length;
        }

        if (script.includes("LSET")) {
          const existingIndex = state.queue.findIndex(
            (queuedPayload) => parseRawEvent(queuedPayload).idempotencyKey === idempotencyKey,
          );
          if (existingIndex >= 0) {
            state.queue[existingIndex] = payload;
            return 1;
          }
        }

        return 0;
      }),
      rPush: vi.fn(async () => 1),
      lPop: vi.fn(async () => state.queue.shift() ?? null),
      lLen: vi.fn(),
      lRange: vi.fn(),
      lRem: vi.fn(),
      sRem: vi.fn(async (_key, member) => {
        state.seen.delete(member);
        return 1;
      }),
    };
    const queue = createRedisRawEventQueue({ client, maxAttempts: 3 });

    await expect(
      queue.handleFailedEvent({ event, errorMessage: "processor failed" }),
    ).resolves.toEqual({ action: "requeued", attempts: 1 });

    await expect(queue.dequeueBatch(1)).resolves.toEqual([{ ...event, attempts: 1 }]);
  });

  it("rejects unsafe integer max attempts", () => {
    const client: RedisRawEventQueueClient = {
      eval: vi.fn(),
      rPush: vi.fn(),
      lPop: vi.fn(),
      lLen: vi.fn(),
      lRange: vi.fn(),
      lRem: vi.fn(),
      sRem: vi.fn(),
    };

    expect(() => createRedisRawEventQueue({ client, maxAttempts: 9007199254740992 })).toThrow(
      "maxAttempts must be a positive safe integer",
    );
  });

  it("moves failed raw events to Redis DLQ at max attempts", async () => {
    const client: RedisRawEventQueueClient = {
      eval: vi.fn(),
      rPush: vi.fn(async () => 1),
      lPop: vi.fn(),
      lLen: vi.fn(async () => 5),
      lRange: vi.fn(),
      lRem: vi.fn(),
      sRem: vi.fn(),
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

  it("stores failed raw events in Redis DLQ with stable ids", async () => {
    const client: RedisRawEventQueueClient = {
      eval: vi.fn(),
      rPush: vi.fn(async () => 1),
      lPop: vi.fn(),
      lLen: vi.fn(),
      lRange: vi.fn(),
      lRem: vi.fn(),
      sRem: vi.fn(),
    };
    const queue = createRedisRawEventQueue({
      client,
      maxAttempts: 1,
      now: () => new Date("2026-07-04T01:00:00.000Z"),
      idGenerator: () => "dlq-1",
    });
    const event = eventFixture();

    await queue.handleFailedEvent({ event, errorMessage: "processor failed" });

    expect(client.rPush).toHaveBeenCalledWith(
      "iris:events:raw:dlq",
      JSON.stringify({
        id: "dlq-1",
        event: {
          ...eventFixture({ attempts: 1 }),
          receivedAt: "2026-07-02T01:00:00.000Z",
        },
        errorMessage: "processor failed",
        failedAt: "2026-07-04T01:00:00.000Z",
      }),
    );
  });

  it("bounds failed raw event DLQ error messages", async () => {
    const rPush = vi.fn(async () => 1);
    const client: RedisRawEventQueueClient = {
      eval: vi.fn(),
      rPush,
      lPop: vi.fn(),
      lLen: vi.fn(),
      lRange: vi.fn(),
      lRem: vi.fn(),
      sRem: vi.fn(),
    };
    const queue = createRedisRawEventQueue({
      client,
      maxAttempts: 1,
      now: () => new Date("2026-07-04T01:00:00.000Z"),
      idGenerator: () => "dlq-oversized-error",
    });
    const event = eventFixture();

    await queue.handleFailedEvent({
      event,
      errorMessage: `${"E".repeat(1200)} trailing diagnostic detail`,
    });

    const [, payload] = rPush.mock.calls[0] as unknown as [string, string];
    const parsed = JSON.parse(payload) as { errorMessage: string };
    expect(parsed.errorMessage.length).toBeLessThanOrEqual(1000);
    expect(parsed.errorMessage).toContain("[truncated]");
    expect(parsed.errorMessage).not.toContain("trailing diagnostic detail");
  });

  it("lists Redis raw event DLQ entries and legacy entries", async () => {
    const eventDeadLetter = JSON.stringify({
      id: "dlq-1",
      event: {
        ...eventFixture({ attempts: 3 }),
        receivedAt: "2026-07-02T01:00:00.000Z",
      },
      errorMessage: "processor failed",
      failedAt: "2026-07-04T01:00:00.000Z",
    });
    const legacyDeadLetter = JSON.stringify({
      event: {
        ...eventFixture({
          idempotencyKey: "raw-event:feishu:event-legacy",
          attempts: 3,
        }),
        receivedAt: "2026-07-02T02:00:00.000Z",
      },
      errorMessage: "legacy processor failed",
      failedAt: "2026-07-04T01:01:00.000Z",
    });
    const client: RedisRawEventQueueClient = {
      eval: vi.fn(),
      rPush: vi.fn(),
      lPop: vi.fn(),
      lLen: vi.fn(),
      lRange: vi.fn(async () => [eventDeadLetter, legacyDeadLetter]),
      lRem: vi.fn(),
      sRem: vi.fn(),
    };
    const queue = createRedisRawEventQueue({ client });

    await expect(queue.listDeadLetters({ limit: 20 })).resolves.toEqual([
      {
        id: "dlq-1",
        event: eventFixture({ attempts: 3 }),
        errorMessage: "processor failed",
        failedAt: new Date("2026-07-04T01:00:00.000Z"),
        replayable: true,
      },
      {
        id: expect.stringMatching(/^legacy:1:/),
        event: eventFixture({
          idempotencyKey: "raw-event:feishu:event-legacy",
          attempts: 3,
          receivedAt: new Date("2026-07-02T02:00:00.000Z"),
        }),
        errorMessage: "legacy processor failed",
        failedAt: new Date("2026-07-04T01:01:00.000Z"),
        replayable: false,
      },
    ]);
    expect(client.lRange).toHaveBeenCalledWith("iris:events:raw:dlq", 0, 19);
  });

  it("caps oversized Redis raw event DLQ list limits", async () => {
    const client: RedisRawEventQueueClient = {
      eval: vi.fn(),
      rPush: vi.fn(),
      lPop: vi.fn(),
      lLen: vi.fn(),
      lRange: vi.fn(async () => []),
      lRem: vi.fn(),
      sRem: vi.fn(),
    };
    const queue = createRedisRawEventQueue({ client });

    await expect(queue.listDeadLetters({ limit: 101 })).resolves.toEqual([]);

    expect(client.lRange).toHaveBeenCalledWith("iris:events:raw:dlq", 0, 99);
  });

  it("rejects non-finite Redis raw event DLQ list limits before reading Redis", async () => {
    const client: RedisRawEventQueueClient = {
      eval: vi.fn(),
      rPush: vi.fn(),
      lPop: vi.fn(),
      lLen: vi.fn(),
      lRange: vi.fn(async () => []),
      lRem: vi.fn(),
      sRem: vi.fn(),
    };
    const queue = createRedisRawEventQueue({ client });

    await expect(queue.listDeadLetters({ limit: Number.POSITIVE_INFINITY })).rejects.toThrow(
      "raw event queue limit must be a finite safe-magnitude number",
    );
    await expect(queue.listDeadLetters({ limit: Number.NaN })).rejects.toThrow(
      "raw event queue limit must be a finite safe-magnitude number",
    );
    expect(client.lRange).not.toHaveBeenCalled();
  });

  it("rejects unsafe Redis raw event DLQ list limits before reading Redis", async () => {
    const client: RedisRawEventQueueClient = {
      eval: vi.fn(),
      rPush: vi.fn(),
      lPop: vi.fn(),
      lLen: vi.fn(),
      lRange: vi.fn(async () => []),
      lRem: vi.fn(),
      sRem: vi.fn(),
    };
    const queue = createRedisRawEventQueue({ client });

    await expect(
      queue.listDeadLetters({ limit: Number.MAX_SAFE_INTEGER + 1 }),
    ).rejects.toThrow("raw event queue limit must be a finite safe-magnitude number");
    expect(client.lRange).not.toHaveBeenCalled();
  });

  it("lists invalid raw event DLQ payloads as non-replayable diagnostics", async () => {
    const payload = JSON.stringify({
      id: "dlq-invalid",
      rawPayload: "{",
      errorMessage: "Invalid raw event JSON",
      failedAt: "2026-07-04T01:02:00.000Z",
    });
    const client: RedisRawEventQueueClient = {
      eval: vi.fn(),
      rPush: vi.fn(),
      lPop: vi.fn(),
      lLen: vi.fn(),
      lRange: vi.fn(async () => [payload]),
      lRem: vi.fn(),
      sRem: vi.fn(),
    };
    const queue = createRedisRawEventQueue({ client });

    await expect(queue.listDeadLetters({ limit: 20 })).resolves.toEqual([
      {
        id: "dlq-invalid",
        rawPayload: "{",
        errorMessage: "Invalid raw event JSON",
        failedAt: new Date("2026-07-04T01:02:00.000Z"),
        replayable: false,
      },
    ]);
  });

  it("lists corrupt Redis raw event DLQ payloads as non-replayable diagnostics", async () => {
    const storedPayload = JSON.stringify({
      id: "dlq-1",
      event: {
        ...eventFixture({ attempts: 3 }),
        receivedAt: "2026-07-02T01:00:00.000Z",
      },
      errorMessage: "processor failed",
      failedAt: "2026-07-04T01:00:00.000Z",
    });
    const client: RedisRawEventQueueClient = {
      eval: vi.fn(),
      rPush: vi.fn(),
      lPop: vi.fn(),
      lLen: vi.fn(),
      lRange: vi.fn(async () => ["{", storedPayload]),
      lRem: vi.fn(),
      sRem: vi.fn(),
    };
    const queue = createRedisRawEventQueue({
      client,
      now: () => new Date("2026-07-04T01:03:00.000Z"),
    });

    await expect(queue.listDeadLetters({ limit: 2 })).resolves.toEqual([
      {
        id: expect.stringMatching(/^legacy:0:/),
        rawPayload: "{",
        errorMessage: "Invalid raw event dead letter JSON",
        failedAt: new Date("2026-07-04T01:03:00.000Z"),
        replayable: false,
      },
      {
        id: "dlq-1",
        event: eventFixture({ attempts: 3 }),
        errorMessage: "processor failed",
        failedAt: new Date("2026-07-04T01:00:00.000Z"),
        replayable: true,
      },
    ]);
  });

  it("replays Redis raw event DLQ entries with attempts reset", async () => {
    const payload = JSON.stringify({
      id: "dlq-1",
      event: {
        ...eventFixture({ attempts: 3 }),
        receivedAt: "2026-07-02T01:00:00.000Z",
      },
      errorMessage: "processor failed",
      failedAt: "2026-07-04T01:00:00.000Z",
    });
    const client: RedisRawEventQueueClient = {
      eval: vi.fn(async () => 1),
      rPush: vi.fn(),
      lPop: vi.fn(),
      lLen: vi.fn(),
      lRange: vi.fn(async () => [payload]),
      lRem: vi.fn(async () => 1),
      sRem: vi.fn(),
    };
    const queue = createRedisRawEventQueue({ client });

    await expect(queue.replayDeadLetter("dlq-1")).resolves.toBe("replayed");
    expect(client.eval).toHaveBeenCalledWith(expect.stringContaining("SADD"), {
      keys: ["iris:events:raw:seen", "iris:events:raw:queue"],
      arguments: [
        eventFixture().idempotencyKey,
        serializeRawEvent(eventFixture({ attempts: 0 })),
      ],
    });
    expect(client.lRem).toHaveBeenCalledWith("iris:events:raw:dlq", 1, payload);
  });

  it("keeps Redis raw event DLQ entries when replay enqueue fails", async () => {
    const payload = JSON.stringify({
      id: "dlq-1",
      event: {
        ...eventFixture({ attempts: 3 }),
        receivedAt: "2026-07-02T01:00:00.000Z",
      },
      errorMessage: "processor failed",
      failedAt: "2026-07-04T01:00:00.000Z",
    });
    const client: RedisRawEventQueueClient = {
      eval: vi.fn(async () => {
        throw new Error("redis enqueue unavailable");
      }),
      rPush: vi.fn(),
      lPop: vi.fn(),
      lLen: vi.fn(),
      lRange: vi.fn(async () => [payload]),
      lRem: vi.fn(async () => 1),
      sRem: vi.fn(),
    };
    const queue = createRedisRawEventQueue({ client });

    await expect(queue.replayDeadLetter("dlq-1")).rejects.toThrow(
      "redis enqueue unavailable",
    );
    expect(client.lRem).not.toHaveBeenCalled();
  });

  it("does not replay invalid or legacy raw event DLQ entries", async () => {
    const invalidPayload = JSON.stringify({
      id: "dlq-invalid",
      rawPayload: "{",
      errorMessage: "Invalid raw event JSON",
      failedAt: "2026-07-04T01:02:00.000Z",
    });
    const client: RedisRawEventQueueClient = {
      eval: vi.fn(),
      rPush: vi.fn(),
      lPop: vi.fn(),
      lLen: vi.fn(),
      lRange: vi.fn(async () => [invalidPayload]),
      lRem: vi.fn(),
      sRem: vi.fn(),
    };
    const queue = createRedisRawEventQueue({ client });

    await expect(queue.replayDeadLetter("dlq-invalid")).resolves.toBe(
      "unsupported_legacy_item",
    );
    await expect(queue.replayDeadLetter("legacy:0:abc")).resolves.toBe(
      "unsupported_legacy_item",
    );
    expect(client.eval).not.toHaveBeenCalled();
    expect(client.lRem).not.toHaveBeenCalled();
  });

  it("deletes Redis raw event DLQ entries by stable id", async () => {
    const payload = JSON.stringify({
      id: "dlq-1",
      event: {
        ...eventFixture({ attempts: 3 }),
        receivedAt: "2026-07-02T01:00:00.000Z",
      },
      errorMessage: "processor failed",
      failedAt: "2026-07-04T01:00:00.000Z",
    });
    const client: RedisRawEventQueueClient = {
      eval: vi.fn(),
      rPush: vi.fn(),
      lPop: vi.fn(),
      lLen: vi.fn(),
      lRange: vi.fn(async () => [payload]),
      lRem: vi.fn(async () => 1),
      sRem: vi.fn(),
    };
    const queue = createRedisRawEventQueue({ client });

    await expect(queue.deleteDeadLetter("dlq-1")).resolves.toBe("deleted");
    expect(client.lRem).toHaveBeenCalledWith("iris:events:raw:dlq", 1, payload);
  });

  it("deletes malformed Redis raw event DLQ objects with stored ids", async () => {
    const payload = JSON.stringify({
      id: "dlq-malformed",
      rawPayload: 42,
      errorMessage: "Invalid raw event JSON",
      failedAt: "2026-07-04T01:02:00.000Z",
    });
    const client: RedisRawEventQueueClient = {
      eval: vi.fn(),
      rPush: vi.fn(),
      lPop: vi.fn(),
      lLen: vi.fn(),
      lRange: vi.fn(async () => [payload]),
      lRem: vi.fn(async () => 1),
      sRem: vi.fn(),
    };
    const queue = createRedisRawEventQueue({ client });

    await expect(queue.deleteDeadLetter("dlq-malformed")).resolves.toBe("deleted");
    expect(client.lRem).toHaveBeenCalledWith("iris:events:raw:dlq", 1, payload);
  });

  it("batch replays Redis raw event DLQ entries", async () => {
    const payload = JSON.stringify({
      id: "dlq-1",
      event: {
        ...eventFixture({ attempts: 3 }),
        receivedAt: "2026-07-02T01:00:00.000Z",
      },
      errorMessage: "processor failed",
      failedAt: "2026-07-04T01:00:00.000Z",
    });
    const client: RedisRawEventQueueClient = {
      eval: vi.fn(async () => 1),
      rPush: vi.fn(),
      lPop: vi.fn(),
      lLen: vi.fn(),
      lRange: vi.fn(async () => [payload]),
      lRem: vi.fn(async () => 1),
      sRem: vi.fn(),
    };
    const queue = createRedisRawEventQueue({ client });

    await expect(
      queue.replayDeadLetters({ ids: ["dlq-1", "missing", "legacy:0:abc", "dlq-1"] }),
    ).resolves.toEqual({
      replayedCount: 1,
      notFoundIds: ["missing"],
      unsupportedLegacyIds: ["legacy:0:abc"],
    });
    expect(client.eval).toHaveBeenCalledOnce();
    expect(client.lRem).toHaveBeenCalledOnce();
  });

  it("batch replays Redis raw event DLQ entries without relying on method binding", async () => {
    const payload = JSON.stringify({
      id: "dlq-1",
      event: {
        ...eventFixture({ attempts: 3 }),
        receivedAt: "2026-07-02T01:00:00.000Z",
      },
      errorMessage: "processor failed",
      failedAt: "2026-07-04T01:00:00.000Z",
    });
    const client: RedisRawEventQueueClient = {
      eval: vi.fn(async () => 1),
      rPush: vi.fn(),
      lPop: vi.fn(),
      lLen: vi.fn(),
      lRange: vi.fn(async () => [payload]),
      lRem: vi.fn(async () => 1),
      sRem: vi.fn(),
    };
    const queue = createRedisRawEventQueue({ client });
    const replayDeadLetters = queue.replayDeadLetters;

    await expect(replayDeadLetters({ ids: ["dlq-1"] })).resolves.toEqual({
      replayedCount: 1,
      notFoundIds: [],
      unsupportedLegacyIds: [],
    });
    expect(client.eval).toHaveBeenCalledWith(expect.stringContaining("SADD"), {
      keys: ["iris:events:raw:seen", "iris:events:raw:queue"],
      arguments: [
        eventFixture().idempotencyKey,
        serializeRawEvent(eventFixture({ attempts: 0 })),
      ],
    });
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
