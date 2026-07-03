import { describe, expect, it, vi } from "vitest";

import type { RawEvent } from "../src/events/raw-event-queue.js";
import { createRawEventWorker } from "../src/events/raw-event-worker.js";

describe("RawEventWorker", () => {
  it("processes raw events", async () => {
    const event = eventFixture();
    const worker = createRawEventWorker({
      queue: { dequeueBatch: vi.fn(async () => [event]), handleFailedEvent: vi.fn() },
      processor: { process: vi.fn(async () => undefined) },
    });

    await expect(worker.processBatch({ limit: 10 })).resolves.toEqual([
      { status: "processed", idempotencyKey: event.idempotencyKey, eventType: event.eventType },
    ]);
  });

  it("sanitizes non-finite batch limits to zero", async () => {
    const queue = {
      dequeueBatch: vi.fn(async () => []),
      handleFailedEvent: vi.fn(),
    };
    const worker = createRawEventWorker({
      queue,
      processor: { process: vi.fn(async () => undefined) },
    });

    await expect(worker.processBatch({ limit: Number.POSITIVE_INFINITY })).resolves.toEqual([]);
    await expect(worker.processBatch({ limit: Number.NaN })).resolves.toEqual([]);

    expect(queue.dequeueBatch).toHaveBeenNthCalledWith(1, 0);
    expect(queue.dequeueBatch).toHaveBeenNthCalledWith(2, 0);
  });

  it("requeues failed events and continues processing", async () => {
    const first = eventFixture({ idempotencyKey: "raw-event:feishu:event-1" });
    const second = eventFixture({ idempotencyKey: "raw-event:feishu:event-2" });
    const queue = {
      dequeueBatch: vi.fn(async () => [first, second]),
      handleFailedEvent: vi.fn(async () => ({ action: "requeued" as const, attempts: 1 })),
    };
    const processor = {
      process: vi
        .fn()
        .mockRejectedValueOnce(new Error("processor failed"))
        .mockResolvedValueOnce(undefined),
    };
    const worker = createRawEventWorker({ queue, processor });

    await expect(worker.processBatch({ limit: 10 })).resolves.toEqual([
      {
        status: "failed",
        idempotencyKey: "raw-event:feishu:event-1",
        eventType: "im.message.receive_v1",
        errorMessage: "processor failed",
        retryAction: "requeued",
        attempts: 1,
      },
      {
        status: "processed",
        idempotencyKey: "raw-event:feishu:event-2",
        eventType: "im.message.receive_v1",
      },
    ]);
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
