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

  it("treats non-finite dequeue limits as zero", async () => {
    const queue = new InMemoryRawEventQueue();
    const event = eventFixture();

    await queue.enqueue(event);

    await expect(queue.dequeueBatch(Number.POSITIVE_INFINITY)).resolves.toEqual([]);
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

  it("requeues failed events below max attempts", async () => {
    const queue = new InMemoryRawEventQueue({ maxAttempts: 3 });
    const event = eventFixture();

    await expect(
      queue.handleFailedEvent({ event, errorMessage: "processor failed" }),
    ).resolves.toEqual({ action: "requeued", attempts: 1 });
    await expect(queue.dequeueBatch(1)).resolves.toEqual([{ ...event, attempts: 1 }]);
    await expect(queue.getDeadLetterCount()).resolves.toBe(0);
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
