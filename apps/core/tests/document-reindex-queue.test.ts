import { describe, expect, it } from "vitest";

import {
  createDocumentReindexIdempotencyKey,
  type DocumentReindexJob,
} from "../src/reindex/document-reindex-queue.js";
import { InMemoryDocumentReindexQueue } from "../src/reindex/in-memory-document-reindex-queue.js";

describe("InMemoryDocumentReindexQueue", () => {
  it("deduplicates jobs by idempotency key", async () => {
    const queue = new InMemoryDocumentReindexQueue();
    const job = jobFixture();

    await queue.enqueue(job);
    await queue.enqueue({ ...job, enqueuedAt: new Date("2026-07-02T02:00:00.000Z") });

    await expect(queue.dequeueBatch(10)).resolves.toEqual([job]);
    await expect(queue.dequeueBatch(10)).resolves.toEqual([]);
  });

  it("allows completed idempotency keys to be enqueued again", async () => {
    const queue = new InMemoryDocumentReindexQueue();
    const first = jobFixture();
    const second = jobFixture({ enqueuedAt: new Date("2026-07-02T02:00:00.000Z") });

    await queue.enqueue(first);
    await expect(queue.dequeueBatch(1)).resolves.toEqual([first]);

    await queue.enqueue(second);

    await expect(queue.dequeueBatch(1)).resolves.toEqual([second]);
  });

  it("dequeues at most the requested batch size in FIFO order", async () => {
    const queue = new InMemoryDocumentReindexQueue();
    const first = jobFixture({ documentSnapshotId: "snapshot-1" });
    const second = jobFixture({ documentSnapshotId: "snapshot-2" });

    await queue.enqueue(first);
    await queue.enqueue(second);

    await expect(queue.dequeueBatch(1)).resolves.toEqual([first]);
    await expect(queue.dequeueBatch(10)).resolves.toEqual([second]);
  });

  it("insulates queued jobs from caller mutations", async () => {
    const queue = new InMemoryDocumentReindexQueue();
    const job = jobFixture({ documentSnapshotId: "snapshot-original" });

    await queue.enqueue(job);
    job.documentSnapshotId = "snapshot-mutated";
    job.enqueuedAt.setUTCFullYear(2030);

    await expect(queue.dequeueBatch(1)).resolves.toEqual([
      jobFixture({ documentSnapshotId: "snapshot-original" }),
    ]);
  });

  it("treats non-finite dequeue limits as zero", async () => {
    const queue = new InMemoryDocumentReindexQueue();
    const job = jobFixture();

    await queue.enqueue(job);

    await expect(queue.dequeueBatch(Number.POSITIVE_INFINITY)).resolves.toEqual([]);
    await expect(queue.dequeueBatch(1)).resolves.toEqual([job]);
  });

  it("rejects unsafe dequeue limits without consuming jobs", async () => {
    const queue = new InMemoryDocumentReindexQueue();
    const job = jobFixture();

    await queue.enqueue(job);

    await expect(queue.dequeueBatch(Number.MAX_SAFE_INTEGER + 1)).rejects.toThrow(
      "document reindex queue limit must be a finite safe-magnitude number",
    );
    await expect(queue.dequeueBatch(1)).resolves.toEqual([job]);
  });

  it("caps oversized dequeue limits", async () => {
    const queue = new InMemoryDocumentReindexQueue();
    for (let index = 0; index < 101; index += 1) {
      await queue.enqueue(jobFixture({ documentSnapshotId: `snapshot-${index}` }));
    }

    await expect(queue.dequeueBatch(101)).resolves.toHaveLength(100);
    await expect(queue.dequeueBatch(1)).resolves.toEqual([
      jobFixture({ documentSnapshotId: "snapshot-100" }),
    ]);
  });

  it("creates stable idempotency keys", () => {
    expect(
      createDocumentReindexIdempotencyKey({
        embeddingProfileId: "profile-1",
        documentSnapshotId: "snapshot-1",
      }),
    ).toBe("reindex:profile-1:snapshot-1");
    expect(
      createDocumentReindexIdempotencyKey({
        embeddingProfileId: " profile-1 ",
        documentSnapshotId: " snapshot-1 ",
      }),
    ).toBe("reindex:profile-1:snapshot-1");
  });

  it("rejects blank ids for idempotency keys", () => {
    expect(() =>
      createDocumentReindexIdempotencyKey({
        embeddingProfileId: "   ",
        documentSnapshotId: "snapshot-1",
      }),
    ).toThrow("embeddingProfileId must be nonblank");
    expect(() =>
      createDocumentReindexIdempotencyKey({
        embeddingProfileId: "profile-1",
        documentSnapshotId: "   ",
      }),
    ).toThrow("documentSnapshotId must be nonblank");
  });

  it("rejects oversized in-memory document reindex job identifiers before enqueue", async () => {
    const queue = new InMemoryDocumentReindexQueue();
    const oversizedJob: DocumentReindexJob = {
      ...jobFixture(),
      idempotencyKey: `reindex:${"p".repeat(513)}:snapshot-1`,
      embeddingProfileId: "p".repeat(513),
    };

    await expect(queue.enqueue(oversizedJob)).rejects.toThrow(
      "Invalid document reindex job payload",
    );
    await expect(queue.getPendingCount()).resolves.toBe(0);
  });

  it("reports pending job count", async () => {
    const queue = new InMemoryDocumentReindexQueue();

    await expect(queue.getPendingCount()).resolves.toBe(0);
    await queue.enqueue(jobFixture({ documentSnapshotId: "snapshot-1" }));
    await queue.enqueue(jobFixture({ documentSnapshotId: "snapshot-2" }));
    await expect(queue.getPendingCount()).resolves.toBe(2);
    await queue.dequeueBatch(1);
    await expect(queue.getPendingCount()).resolves.toBe(1);
  });

  it("requeues failed jobs below max attempts", async () => {
    const queue = new InMemoryDocumentReindexQueue({ maxAttempts: 3 });
    const job = jobFixture();

    await expect(
      queue.handleFailedJob({ job, errorMessage: "embedding failed" }),
    ).resolves.toEqual({ action: "requeued", attempts: 1 });
    await expect(queue.dequeueBatch(1)).resolves.toEqual([{ ...job, attempts: 1 }]);
    await expect(queue.getDeadLetterCount()).resolves.toBe(0);
  });

  it("rejects unsafe integer max attempts", () => {
    expect(() => new InMemoryDocumentReindexQueue({ maxAttempts: 9007199254740992 })).toThrow(
      "maxAttempts must be a positive safe integer",
    );
  });

  it("keeps requeued failed jobs deduplicated by idempotency key", async () => {
    const queue = new InMemoryDocumentReindexQueue({ maxAttempts: 3 });
    const job = jobFixture();

    await queue.handleFailedJob({ job, errorMessage: "embedding failed" });
    await queue.enqueue({ ...job, enqueuedAt: new Date("2026-07-02T02:00:00.000Z") });

    await expect(queue.dequeueBatch(10)).resolves.toEqual([{ ...job, attempts: 1 }]);
  });

  it("upgrades a pending duplicate when the in-flight job fails", async () => {
    const queue = new InMemoryDocumentReindexQueue({ maxAttempts: 3 });
    const job = jobFixture();

    await queue.enqueue(job);
    await expect(queue.dequeueBatch(1)).resolves.toEqual([job]);
    await queue.enqueue({ ...job, enqueuedAt: new Date("2026-07-02T02:00:00.000Z") });
    await queue.handleFailedJob({ job, errorMessage: "embedding failed" });

    await expect(queue.dequeueBatch(10)).resolves.toEqual([{ ...job, attempts: 1 }]);
  });

  it("moves failed jobs to DLQ at max attempts", async () => {
    const queue = new InMemoryDocumentReindexQueue({ maxAttempts: 3 });
    const job = jobFixture({ attempts: 2 });

    await expect(
      queue.handleFailedJob({ job, errorMessage: "embedding failed" }),
    ).resolves.toEqual({ action: "dead_lettered", attempts: 3 });
    await expect(queue.dequeueBatch(1)).resolves.toEqual([]);
    await expect(queue.getDeadLetterCount()).resolves.toBe(1);
  });

  it("lists dead-lettered jobs with generated ids", async () => {
    const queue = new InMemoryDocumentReindexQueue({
      maxAttempts: 1,
      idGenerator: () => "dlq-1",
      now: () => new Date("2026-07-02T01:05:00.000Z"),
    });
    const job = jobFixture();

    await queue.handleFailedJob({ job, errorMessage: "embedding failed" });

    await expect(queue.listDeadLetters({ limit: 20 })).resolves.toEqual([
      {
        id: "dlq-1",
        job: { ...job, attempts: 1 },
        errorMessage: "embedding failed",
        failedAt: new Date("2026-07-02T01:05:00.000Z"),
        replayable: true,
      },
    ]);
  });

  it("insulates stored DLQ entries from returned object mutations", async () => {
    const queue = new InMemoryDocumentReindexQueue({
      maxAttempts: 1,
      idGenerator: () => "dlq-1",
      now: () => new Date("2026-07-02T01:05:00.000Z"),
    });
    const job = jobFixture();

    await queue.handleFailedJob({ job, errorMessage: "embedding failed" });
    const [first] = await queue.listDeadLetters({ limit: 20 });
    if (!("job" in first)) {
      throw new Error("expected job dead letter");
    }
    first.job.documentSnapshotId = "snapshot-mutated";
    first.job.enqueuedAt.setUTCFullYear(2030);
    first.failedAt.setUTCFullYear(2030);

    await expect(queue.listDeadLetters({ limit: 20 })).resolves.toEqual([
      {
        id: "dlq-1",
        job: { ...job, attempts: 1 },
        errorMessage: "embedding failed",
        failedAt: new Date("2026-07-02T01:05:00.000Z"),
        replayable: true,
      },
    ]);
  });

  it("treats non-finite dead-letter list limits as zero", async () => {
    const queue = new InMemoryDocumentReindexQueue({
      maxAttempts: 1,
      idGenerator: () => "dlq-1",
      now: () => new Date("2026-07-02T01:05:00.000Z"),
    });

    await queue.handleFailedJob({ job: jobFixture(), errorMessage: "embedding failed" });

    await expect(queue.listDeadLetters({ limit: Number.POSITIVE_INFINITY })).resolves.toEqual([]);
    await expect(queue.listDeadLetters({ limit: 1 })).resolves.toHaveLength(1);
  });

  it("rejects unsafe dead-letter list limits", async () => {
    const queue = new InMemoryDocumentReindexQueue({
      maxAttempts: 1,
      idGenerator: () => "dlq-1",
      now: () => new Date("2026-07-02T01:05:00.000Z"),
    });

    await queue.handleFailedJob({ job: jobFixture(), errorMessage: "embedding failed" });

    await expect(queue.listDeadLetters({ limit: Number.MAX_SAFE_INTEGER + 1 })).rejects.toThrow(
      "document reindex queue limit must be a finite safe-magnitude number",
    );
    await expect(queue.listDeadLetters({ limit: 1 })).resolves.toHaveLength(1);
  });

  it("caps oversized dead-letter list limits", async () => {
    const queue = new InMemoryDocumentReindexQueue({
      maxAttempts: 1,
      idGenerator: (() => {
        let nextId = 0;
        return () => `dlq-${nextId++}`;
      })(),
    });

    for (let index = 0; index < 101; index += 1) {
      await queue.handleFailedJob({
        job: jobFixture({ documentSnapshotId: `snapshot-${index}` }),
        errorMessage: "embedding failed",
      });
    }

    const deadLetters = await queue.listDeadLetters({ limit: 101 });

    expect(deadLetters).toHaveLength(100);
    expect(deadLetters.at(-1)?.id).toBe("dlq-99");
  });

  it("replays dead-lettered jobs with attempts reset", async () => {
    const queue = new InMemoryDocumentReindexQueue({
      maxAttempts: 1,
      idGenerator: () => "dlq-1",
      now: () => new Date("2026-07-02T01:05:00.000Z"),
    });
    const job = jobFixture({ attempts: 0 });
    await queue.handleFailedJob({ job, errorMessage: "embedding failed" });

    await expect(queue.replayDeadLetter("dlq-1")).resolves.toBe("replayed");
    await expect(queue.listDeadLetters({ limit: 20 })).resolves.toEqual([]);
    await expect(queue.dequeueBatch(1)).resolves.toEqual([{ ...job, attempts: 0 }]);
  });

  it("does not duplicate a pending job when replaying a dead letter with the same key", async () => {
    const queue = new InMemoryDocumentReindexQueue({
      maxAttempts: 1,
      idGenerator: () => "dlq-1",
    });
    const job = jobFixture();

    await queue.handleFailedJob({ job, errorMessage: "embedding failed" });
    await queue.enqueue({ ...job, enqueuedAt: new Date("2026-07-02T02:00:00.000Z") });

    await expect(queue.replayDeadLetter("dlq-1")).resolves.toBe("replayed");
    await expect(queue.dequeueBatch(10)).resolves.toEqual([job]);
  });

  it("deletes dead-lettered jobs without replaying them", async () => {
    const queue = new InMemoryDocumentReindexQueue({
      maxAttempts: 1,
      idGenerator: () => "dlq-1",
      now: () => new Date("2026-07-02T01:05:00.000Z"),
    });
    await queue.handleFailedJob({ job: jobFixture(), errorMessage: "embedding failed" });

    await expect(queue.deleteDeadLetter("dlq-1")).resolves.toBe("deleted");
    await expect(queue.listDeadLetters({ limit: 20 })).resolves.toEqual([]);
    await expect(queue.dequeueBatch(1)).resolves.toEqual([]);
  });

  it("classifies legacy document reindex DLQ ids as unsupported", async () => {
    const queue = new InMemoryDocumentReindexQueue();

    await expect(queue.replayDeadLetter("legacy:0:abc")).resolves.toBe(
      "unsupported_legacy_item",
    );
    await expect(queue.deleteDeadLetter("legacy:0:abc")).resolves.toBe(
      "unsupported_legacy_item",
    );
    await expect(queue.replayDeadLetter("missing")).resolves.toBe("not_found");
    await expect(queue.deleteDeadLetter("missing")).resolves.toBe("not_found");
  });

  it("batch replays dead-lettered jobs", async () => {
    let nextId = 1;
    const queue = new InMemoryDocumentReindexQueue({
      maxAttempts: 1,
      idGenerator: () => `dlq-${nextId++}`,
    });
    await queue.handleFailedJob({
      job: jobFixture({ documentSnapshotId: "snapshot-1" }),
      errorMessage: "first",
    });
    await queue.handleFailedJob({
      job: jobFixture({
        idempotencyKey: "reindex:profile-1:snapshot-2",
        documentSnapshotId: "snapshot-2",
      }),
      errorMessage: "second",
    });

    await expect(queue.replayDeadLetters({ ids: ["dlq-1", "missing", "dlq-2"] })).resolves.toEqual({
      replayedCount: 2,
      notFoundIds: ["missing"],
      unsupportedLegacyIds: [],
    });
    await expect(queue.getDeadLetterCount()).resolves.toBe(0);
    await expect(queue.dequeueBatch(10)).resolves.toHaveLength(2);
  });

  it("batch replays dead-lettered jobs without relying on method binding", async () => {
    const queue = new InMemoryDocumentReindexQueue({
      maxAttempts: 1,
      idGenerator: () => "dlq-1",
    });
    await queue.handleFailedJob({
      job: jobFixture(),
      errorMessage: "embedding failed",
    });
    const replayDeadLetters = queue.replayDeadLetters;

    await expect(replayDeadLetters({ ids: ["dlq-1"] })).resolves.toEqual({
      replayedCount: 1,
      notFoundIds: [],
      unsupportedLegacyIds: [],
    });
    await expect(queue.dequeueBatch(1)).resolves.toEqual([jobFixture()]);
  });

  it("deduplicates repeated ids in batch replay requests", async () => {
    const queue = new InMemoryDocumentReindexQueue({
      maxAttempts: 1,
      idGenerator: () => "dlq-1",
    });
    await queue.handleFailedJob({
      job: jobFixture(),
      errorMessage: "embedding failed",
    });

    await expect(queue.replayDeadLetters({ ids: ["dlq-1", "dlq-1"] })).resolves.toEqual({
      replayedCount: 1,
      notFoundIds: [],
      unsupportedLegacyIds: [],
    });
  });
});

function jobFixture(overrides: Partial<DocumentReindexJob> = {}): DocumentReindexJob {
  const embeddingProfileId = overrides.embeddingProfileId ?? "profile-1";
  const documentSnapshotId = overrides.documentSnapshotId ?? "snapshot-1";

  return {
    idempotencyKey: createDocumentReindexIdempotencyKey({
      embeddingProfileId,
      documentSnapshotId,
    }),
    embeddingProfileId,
    documentSnapshotId,
    reason: "manual_profile_reindex",
    enqueuedAt: new Date("2026-07-02T01:00:00.000Z"),
    attempts: 0,
    ...overrides,
  };
}
