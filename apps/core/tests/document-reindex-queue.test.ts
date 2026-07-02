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

  it("dequeues at most the requested batch size in FIFO order", async () => {
    const queue = new InMemoryDocumentReindexQueue();
    const first = jobFixture({ documentSnapshotId: "snapshot-1" });
    const second = jobFixture({ documentSnapshotId: "snapshot-2" });

    await queue.enqueue(first);
    await queue.enqueue(second);

    await expect(queue.dequeueBatch(1)).resolves.toEqual([first]);
    await expect(queue.dequeueBatch(10)).resolves.toEqual([second]);
  });

  it("creates stable idempotency keys", () => {
    expect(
      createDocumentReindexIdempotencyKey({
        embeddingProfileId: "profile-1",
        documentSnapshotId: "snapshot-1",
      }),
    ).toBe("reindex:profile-1:snapshot-1");
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
    ...overrides,
  };
}
