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

  it("rejects non-finite batch limits before dequeuing events", async () => {
    const queue = {
      dequeueBatch: vi.fn(async () => []),
      handleFailedEvent: vi.fn(),
    };
    const worker = createRawEventWorker({
      queue,
      processor: { process: vi.fn(async () => undefined) },
    });

    await expect(worker.processBatch({ limit: Number.POSITIVE_INFINITY })).rejects.toThrow(
      "raw event worker batch limit must be a finite safe-magnitude number",
    );
    await expect(worker.processBatch({ limit: Number.NaN })).rejects.toThrow(
      "raw event worker batch limit must be a finite safe-magnitude number",
    );

    expect(queue.dequeueBatch).not.toHaveBeenCalled();
  });

  it("rejects unsafe batch limits before dequeuing events", async () => {
    const queue = {
      dequeueBatch: vi.fn(async () => []),
      handleFailedEvent: vi.fn(),
    };
    const worker = createRawEventWorker({
      queue,
      processor: { process: vi.fn(async () => undefined) },
    });

    await expect(worker.processBatch({ limit: Number.MAX_SAFE_INTEGER + 1 })).rejects.toThrow(
      "raw event worker batch limit must be a finite safe-magnitude number",
    );
    expect(queue.dequeueBatch).not.toHaveBeenCalled();
  });

  it("caps oversized batch limits before dequeuing events", async () => {
    const queue = {
      dequeueBatch: vi.fn(async () => []),
      handleFailedEvent: vi.fn(),
    };
    const worker = createRawEventWorker({
      queue,
      processor: { process: vi.fn(async () => undefined) },
    });

    await expect(worker.processBatch({ limit: 101 })).resolves.toEqual([]);

    expect(queue.dequeueBatch).toHaveBeenCalledWith(100);
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

  it("retries transient failure handling errors before continuing the batch", async () => {
    const first = eventFixture({ idempotencyKey: "raw-event:feishu:event-1" });
    const second = eventFixture({ idempotencyKey: "raw-event:feishu:event-2" });
    const queue = {
      dequeueBatch: vi.fn(async () => [first, second]),
      handleFailedEvent: vi
        .fn()
        .mockRejectedValueOnce(new Error("redis unavailable"))
        .mockResolvedValueOnce({ action: "requeued" as const, attempts: 1 }),
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
    expect(queue.handleFailedEvent).toHaveBeenCalledTimes(2);
  });

  it("bounds failed event error messages before returning and requeueing", async () => {
    const event = eventFixture({ idempotencyKey: "raw-event:feishu:oversized-error" });
    const oversizedMessage = `${"E".repeat(1200)} trailing diagnostic detail`;
    const queue = {
      dequeueBatch: vi.fn(async () => [event]),
      handleFailedEvent: vi.fn(async () => ({ action: "requeued" as const, attempts: 1 })),
    };
    const worker = createRawEventWorker({
      queue,
      processor: {
        process: vi.fn(async () => {
          throw new Error(oversizedMessage);
        }),
      },
    });

    const [result] = await worker.processBatch({ limit: 10 });

    expect(result?.status).toBe("failed");
    if (result?.status !== "failed") {
      throw new Error("expected failed worker result");
    }
    expect(result.errorMessage.length).toBeLessThanOrEqual(1000);
    expect(result.errorMessage).toContain("[truncated]");
    expect(result.errorMessage).not.toContain("trailing diagnostic detail");
    expect(queue.handleFailedEvent).toHaveBeenCalledWith({
      event,
      errorMessage: result.errorMessage,
    });
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
