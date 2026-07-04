import { describe, expect, it } from "vitest";

import {
  createRawEventIdempotencyKey,
  type RawEvent,
} from "../src/events/raw-event-queue.js";
import { InMemoryRawEventQueue } from "../src/events/in-memory-raw-event-queue.js";

describe("InMemoryRawEventQueue", () => {
  it("deduplicates events by idempotency key", async () => {
    const queue = new InMemoryRawEventQueue();
    const event = eventFixture();

    await queue.enqueue(event);
    await queue.enqueue({ ...event, receivedAt: new Date("2026-07-02T02:00:00.000Z") });

    await expect(queue.dequeueBatch(10)).resolves.toEqual([event]);
  });

  it("dequeues events in FIFO order", async () => {
    const queue = new InMemoryRawEventQueue();
    const first = eventFixture({ idempotencyKey: "raw-event:feishu:event-1" });
    const second = eventFixture({ idempotencyKey: "raw-event:feishu:event-2" });

    await queue.enqueue(first);
    await queue.enqueue(second);

    await expect(queue.dequeueBatch(1)).resolves.toEqual([first]);
    await expect(queue.dequeueBatch(10)).resolves.toEqual([second]);
  });

  it("rejects oversized in-memory raw event identifiers before enqueue", async () => {
    const queue = new InMemoryRawEventQueue();

    await expect(
      queue.enqueue({
        ...eventFixture(),
        idempotencyKey: `raw-event:feishu:${"e".repeat(513)}`,
      }),
    ).rejects.toThrow("Invalid raw event payload");
    await expect(
      queue.enqueue({
        ...eventFixture(),
        eventType: "t".repeat(513),
      }),
    ).rejects.toThrow("Invalid raw event payload");
    await expect(queue.getPendingCount()).resolves.toBe(0);
  });

  it("releases dequeued event idempotency keys so later retries can enqueue", async () => {
    const queue = new InMemoryRawEventQueue();
    const event = eventFixture();

    await queue.enqueue(event);
    await expect(queue.dequeueBatch(1)).resolves.toEqual([event]);

    await queue.enqueue({ ...event, receivedAt: new Date("2026-07-02T02:00:00.000Z") });

    await expect(queue.dequeueBatch(1)).resolves.toEqual([
      { ...event, receivedAt: new Date("2026-07-02T02:00:00.000Z") },
    ]);
  });

  it("insulates queued events from caller mutations", async () => {
    const queue = new InMemoryRawEventQueue();
    const event = eventFixture({
      rawBody: { event_id: "event-original", nested: { value: "original" } },
    });

    await queue.enqueue(event);
    event.eventType = "mutated";
    event.receivedAt.setUTCFullYear(2030);
    (event.rawBody as { event_id: string; nested: { value: string } }).event_id = "event-mutated";
    (event.rawBody as { event_id: string; nested: { value: string } }).nested.value = "mutated";

    await expect(queue.dequeueBatch(1)).resolves.toEqual([
      eventFixture({
        rawBody: { event_id: "event-original", nested: { value: "original" } },
      }),
    ]);
  });

  it("treats non-finite dequeue limits as zero", async () => {
    const queue = new InMemoryRawEventQueue();
    const event = eventFixture();

    await queue.enqueue(event);

    await expect(queue.dequeueBatch(Number.POSITIVE_INFINITY)).resolves.toEqual([]);
    await expect(queue.dequeueBatch(1)).resolves.toEqual([event]);
  });

  it("rejects unsafe dequeue limits without consuming events", async () => {
    const queue = new InMemoryRawEventQueue();
    const event = eventFixture();

    await queue.enqueue(event);

    await expect(queue.dequeueBatch(Number.MAX_SAFE_INTEGER + 1)).rejects.toThrow(
      "raw event queue limit must be a finite safe-magnitude number",
    );
    await expect(queue.dequeueBatch(1)).resolves.toEqual([event]);
  });

  it("creates stable idempotency keys", () => {
    expect(createRawEventIdempotencyKey({ provider: "feishu", eventId: "evt-1" })).toBe(
      "raw-event:feishu:evt-1",
    );
    expect(createRawEventIdempotencyKey({ provider: "feishu", eventId: " evt-1 " })).toBe(
      "raw-event:feishu:evt-1",
    );
  });

  it("rejects blank event ids for idempotency keys", () => {
    expect(() => createRawEventIdempotencyKey({ provider: "feishu", eventId: "   " })).toThrow(
      "eventId must be nonblank",
    );
  });

  it("rejects oversized event ids for idempotency keys", () => {
    expect(() =>
      createRawEventIdempotencyKey({ provider: "feishu", eventId: "a".repeat(513) }),
    ).toThrow("eventId must be at most 512 characters");
  });

  it("requeues failed events below max attempts", async () => {
    const queue = new InMemoryRawEventQueue({ maxAttempts: 3 });
    const event = eventFixture();

    await expect(
      queue.handleFailedEvent({ event, errorMessage: "processor failed" }),
    ).resolves.toEqual({ action: "requeued", attempts: 1 });
    await expect(queue.dequeueBatch(1)).resolves.toEqual([{ ...event, attempts: 1 }]);
    await expect(queue.getDeadLetterCount()).resolves.toBe(0);
  });

  it("rejects unsafe integer max attempts", () => {
    expect(() => new InMemoryRawEventQueue({ maxAttempts: 9007199254740992 })).toThrow(
      "maxAttempts must be a positive safe integer",
    );
  });

  it("deduplicates platform retries after a failed event is requeued", async () => {
    const queue = new InMemoryRawEventQueue({ maxAttempts: 3 });
    const event = eventFixture();

    await queue.enqueue(event);
    await expect(queue.dequeueBatch(1)).resolves.toEqual([event]);
    await queue.handleFailedEvent({ event, errorMessage: "processor failed" });
    await queue.enqueue({ ...event, receivedAt: new Date("2026-07-02T02:00:00.000Z") });

    await expect(queue.dequeueBatch(10)).resolves.toEqual([{ ...event, attempts: 1 }]);
  });

  it("upgrades a pending platform retry when the in-flight event fails", async () => {
    const queue = new InMemoryRawEventQueue({ maxAttempts: 3 });
    const event = eventFixture();

    await queue.enqueue(event);
    await expect(queue.dequeueBatch(1)).resolves.toEqual([event]);
    await queue.enqueue({ ...event, receivedAt: new Date("2026-07-02T02:00:00.000Z") });
    await queue.handleFailedEvent({ event, errorMessage: "processor failed" });

    await expect(queue.dequeueBatch(10)).resolves.toEqual([{ ...event, attempts: 1 }]);
  });

  it("insulates requeued failed events from caller mutations", async () => {
    const queue = new InMemoryRawEventQueue({ maxAttempts: 3 });
    const event = eventFixture({
      rawBody: { event_id: "event-original", nested: { value: "original" } },
    });

    await queue.handleFailedEvent({ event, errorMessage: "processor failed" });
    event.eventType = "mutated";
    event.receivedAt.setUTCFullYear(2030);
    (event.rawBody as { event_id: string; nested: { value: string } }).event_id = "event-mutated";
    (event.rawBody as { event_id: string; nested: { value: string } }).nested.value = "mutated";

    await expect(queue.dequeueBatch(1)).resolves.toEqual([
      {
        ...eventFixture({
          rawBody: { event_id: "event-original", nested: { value: "original" } },
        }),
        attempts: 1,
      },
    ]);
  });

  it("moves failed events to DLQ at max attempts", async () => {
    const queue = new InMemoryRawEventQueue({ maxAttempts: 3 });
    const event = eventFixture({ attempts: 2 });

    await expect(
      queue.handleFailedEvent({ event, errorMessage: "processor failed" }),
    ).resolves.toEqual({ action: "dead_lettered", attempts: 3 });
    await expect(queue.dequeueBatch(1)).resolves.toEqual([]);
    await expect(queue.getDeadLetterCount()).resolves.toBe(1);
  });

  it("lists dead-lettered raw events with generated ids", async () => {
    const queue = new InMemoryRawEventQueue({
      maxAttempts: 1,
      idGenerator: () => "dlq-1",
      now: () => new Date("2026-07-04T01:00:00.000Z"),
    });
    const event = eventFixture();

    await queue.handleFailedEvent({ event, errorMessage: "processor failed" });

    await expect(queue.listDeadLetters({ limit: 20 })).resolves.toEqual([
      {
        id: "dlq-1",
        event: { ...event, attempts: 1 },
        errorMessage: "processor failed",
        failedAt: new Date("2026-07-04T01:00:00.000Z"),
        replayable: true,
      },
    ]);
  });

  it("replays dead-lettered raw events with attempts reset", async () => {
    const queue = new InMemoryRawEventQueue({
      maxAttempts: 1,
      idGenerator: () => "dlq-1",
    });
    const event = eventFixture();
    await queue.handleFailedEvent({ event, errorMessage: "processor failed" });

    await expect(queue.replayDeadLetter("dlq-1")).resolves.toBe("replayed");
    await expect(queue.listDeadLetters({ limit: 20 })).resolves.toEqual([]);
    await expect(queue.dequeueBatch(1)).resolves.toEqual([event]);
  });

  it("deletes dead-lettered raw events without replaying them", async () => {
    const queue = new InMemoryRawEventQueue({
      maxAttempts: 1,
      idGenerator: () => "dlq-1",
    });
    await queue.handleFailedEvent({ event: eventFixture(), errorMessage: "processor failed" });

    await expect(queue.deleteDeadLetter("dlq-1")).resolves.toBe("deleted");
    await expect(queue.listDeadLetters({ limit: 20 })).resolves.toEqual([]);
    await expect(queue.dequeueBatch(1)).resolves.toEqual([]);
  });

  it("classifies legacy raw event DLQ ids as unsupported", async () => {
    const queue = new InMemoryRawEventQueue();

    await expect(queue.replayDeadLetter("legacy:0:abc")).resolves.toBe(
      "unsupported_legacy_item",
    );
    await expect(queue.deleteDeadLetter("legacy:0:abc")).resolves.toBe(
      "unsupported_legacy_item",
    );
    await expect(queue.replayDeadLetter("missing")).resolves.toBe("not_found");
    await expect(queue.deleteDeadLetter("missing")).resolves.toBe("not_found");
  });

  it("batch replays dead-lettered raw events", async () => {
    let nextId = 1;
    const queue = new InMemoryRawEventQueue({
      maxAttempts: 1,
      idGenerator: () => `dlq-${nextId++}`,
    });
    await queue.handleFailedEvent({
      event: eventFixture({ idempotencyKey: "raw-event:feishu:event-1" }),
      errorMessage: "first",
    });
    await queue.handleFailedEvent({
      event: eventFixture({ idempotencyKey: "raw-event:feishu:event-2" }),
      errorMessage: "second",
    });

    await expect(
      queue.replayDeadLetters({ ids: ["dlq-1", "missing", "dlq-2", "dlq-1"] }),
    ).resolves.toEqual({
      replayedCount: 2,
      notFoundIds: ["missing"],
      unsupportedLegacyIds: [],
    });
    await expect(queue.getDeadLetterCount()).resolves.toBe(0);
    await expect(queue.dequeueBatch(10)).resolves.toHaveLength(2);
  });
});

function eventFixture(overrides: Partial<RawEvent> = {}): RawEvent {
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
