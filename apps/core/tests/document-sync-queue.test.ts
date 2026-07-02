import { describe, expect, it } from "vitest";

import {
  createDocumentSyncIdempotencyKey,
  type DocumentSyncJob,
} from "../src/documents/document-sync-queue.js";
import { createInMemoryDocumentSyncQueue } from "../src/documents/in-memory-document-sync-queue.js";

describe("DocumentSyncQueue", () => {
  it("creates stable idempotency keys from document source ids", () => {
    expect(createDocumentSyncIdempotencyKey({ documentSourceId: "source-1" })).toBe(
      "document-sync:source-1",
    );
  });

  it("dequeues jobs in enqueue order", async () => {
    const queue = createInMemoryDocumentSyncQueue();
    const first = job({ documentSourceId: "source-1" });
    const second = job({ documentSourceId: "source-2" });

    await queue.enqueue(first);
    await queue.enqueue(second);

    await expect(queue.getPendingCount()).resolves.toBe(2);
    await expect(queue.dequeueBatch(1)).resolves.toEqual([first]);
    await expect(queue.dequeueBatch(10)).resolves.toEqual([second]);
    await expect(queue.getPendingCount()).resolves.toBe(0);
  });

  it("deduplicates jobs by idempotency key", async () => {
    const queue = createInMemoryDocumentSyncQueue();
    const first = job({ documentSourceId: "source-1" });
    const duplicate = {
      ...first,
      enqueuedAt: new Date("2026-07-03T01:01:00.000Z"),
    };

    await queue.enqueue(first);
    await queue.enqueue(duplicate);

    await expect(queue.getPendingCount()).resolves.toBe(1);
    await expect(queue.dequeueBatch(10)).resolves.toEqual([first]);
  });

  it("requeues failed jobs below max attempts", async () => {
    const queue = createInMemoryDocumentSyncQueue({ maxAttempts: 3 });
    const syncJob = job();

    await expect(
      queue.handleFailedJob({ job: syncJob, errorMessage: "runner crashed" }),
    ).resolves.toEqual({ action: "requeued", attempts: 1 });
    await expect(queue.dequeueBatch(10)).resolves.toEqual([
      { ...syncJob, attempts: 1 },
    ]);
    await expect(queue.getDeadLetterCount()).resolves.toBe(0);
  });

  it("moves failed jobs to DLQ at max attempts", async () => {
    const queue = createInMemoryDocumentSyncQueue({ maxAttempts: 3 });
    const syncJob = job({ attempts: 2 });

    await expect(
      queue.handleFailedJob({ job: syncJob, errorMessage: "runner crashed" }),
    ).resolves.toEqual({ action: "dead_lettered", attempts: 3 });
    await expect(queue.dequeueBatch(10)).resolves.toEqual([]);
    await expect(queue.getDeadLetterCount()).resolves.toBe(1);
  });
});

function job(overrides: Partial<DocumentSyncJob> = {}): DocumentSyncJob {
  const documentSourceId = overrides.documentSourceId ?? "source-1";

  return {
    idempotencyKey:
      overrides.idempotencyKey ?? createDocumentSyncIdempotencyKey({ documentSourceId }),
    documentSourceId,
    reason: "discovered_group_document",
    enqueuedAt: new Date("2026-07-03T01:00:00.000Z"),
    attempts: 0,
    ...overrides,
  };
}
