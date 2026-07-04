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
    expect(createDocumentSyncIdempotencyKey({ documentSourceId: " source-1 " })).toBe(
      "document-sync:source-1",
    );
  });

  it("rejects blank document source ids for idempotency keys", () => {
    expect(() => createDocumentSyncIdempotencyKey({ documentSourceId: "   " })).toThrow(
      "documentSourceId must be nonblank",
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

  it("rejects unsafe dequeue limits without consuming jobs", async () => {
    const queue = createInMemoryDocumentSyncQueue();
    const syncJob = job();

    await queue.enqueue(syncJob);

    await expect(queue.dequeueBatch(Number.MAX_SAFE_INTEGER + 1)).rejects.toThrow(
      "document sync queue limit must be a finite safe-magnitude number",
    );
    await expect(queue.dequeueBatch(1)).resolves.toEqual([syncJob]);
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

  it("rejects oversized in-memory document sync job identifiers before enqueue", async () => {
    const queue = createInMemoryDocumentSyncQueue();
    const oversizedJob: DocumentSyncJob = {
      ...job(),
      idempotencyKey: `document-sync:${"s".repeat(513)}`,
      documentSourceId: "s".repeat(513),
    };

    await expect(queue.enqueue(oversizedJob)).rejects.toThrow(
      "Invalid document sync job payload",
    );
    await expect(queue.getPendingCount()).resolves.toBe(0);
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

  it("rejects unsafe integer max attempts", () => {
    expect(() => createInMemoryDocumentSyncQueue({ maxAttempts: 9007199254740992 })).toThrow(
      "maxAttempts must be a positive safe integer",
    );
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

  it("lists and replays in-memory DLQ entries", async () => {
    const queue = createInMemoryDocumentSyncQueue({
      maxAttempts: 1,
      now: () => new Date("2026-07-03T02:00:00.000Z"),
      idGenerator: () => "dlq-1",
    });
    const syncJob = job();

    await queue.handleFailedJob({ job: syncJob, errorMessage: "runner crashed" });

    await expect(queue.listDeadLetters({ limit: 10 })).resolves.toEqual([
      {
        id: "dlq-1",
        job: { ...syncJob, attempts: 1 },
        errorMessage: "runner crashed",
        failedAt: new Date("2026-07-03T02:00:00.000Z"),
        replayable: true,
      },
    ]);
    await expect(queue.replayDeadLetter("dlq-1")).resolves.toBe("replayed");
    await expect(queue.getDeadLetterCount()).resolves.toBe(0);
    await expect(queue.dequeueBatch(10)).resolves.toEqual([syncJob]);
  });

  it("rejects unsafe in-memory DLQ list limits", async () => {
    const queue = createInMemoryDocumentSyncQueue({
      maxAttempts: 1,
      idGenerator: () => "dlq-1",
    });

    await queue.handleFailedJob({ job: job(), errorMessage: "runner crashed" });

    await expect(queue.listDeadLetters({ limit: Number.MAX_SAFE_INTEGER + 1 })).rejects.toThrow(
      "document sync queue limit must be a finite safe-magnitude number",
    );
    await expect(queue.listDeadLetters({ limit: 1 })).resolves.toHaveLength(1);
  });

  it("deletes in-memory DLQ entries", async () => {
    const queue = createInMemoryDocumentSyncQueue({
      maxAttempts: 1,
      idGenerator: () => "dlq-1",
    });

    await queue.handleFailedJob({ job: job(), errorMessage: "runner crashed" });

    await expect(queue.deleteDeadLetter("dlq-1")).resolves.toBe("deleted");
    await expect(queue.getDeadLetterCount()).resolves.toBe(0);
    await expect(queue.replayDeadLetters({ ids: ["missing"] })).resolves.toEqual({
      replayedCount: 0,
      notFoundIds: ["missing"],
      unsupportedLegacyIds: [],
    });
  });

  it("batch replays in-memory DLQ entries without relying on method binding", async () => {
    const queue = createInMemoryDocumentSyncQueue({
      maxAttempts: 1,
      idGenerator: () => "dlq-1",
    });
    await queue.handleFailedJob({ job: job(), errorMessage: "runner crashed" });
    const replayDeadLetters = queue.replayDeadLetters;

    await expect(replayDeadLetters({ ids: ["dlq-1"] })).resolves.toEqual({
      replayedCount: 1,
      notFoundIds: [],
      unsupportedLegacyIds: [],
    });
    await expect(queue.dequeueBatch(1)).resolves.toEqual([job()]);
  });

  it("deduplicates repeated ids in batch replay requests", async () => {
    const queue = createInMemoryDocumentSyncQueue({
      maxAttempts: 1,
      idGenerator: () => "dlq-1",
    });
    await queue.handleFailedJob({ job: job(), errorMessage: "runner crashed" });

    await expect(queue.replayDeadLetters({ ids: ["dlq-1", "dlq-1"] })).resolves.toEqual({
      replayedCount: 1,
      notFoundIds: [],
      unsupportedLegacyIds: [],
    });
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
