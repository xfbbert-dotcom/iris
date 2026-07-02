import { describe, expect, it, vi } from "vitest";

import {
  createDocumentReindexIdempotencyKey,
  type DocumentReindexJob,
} from "../src/reindex/document-reindex-queue.js";
import {
  createRedisDocumentReindexQueue,
  parseDocumentReindexJob,
  serializeDocumentReindexJob,
  type RedisDocumentReindexQueueClient,
} from "../src/reindex/redis-document-reindex-queue.js";

describe("RedisDocumentReindexQueue", () => {
  it("atomically enqueues jobs through Redis eval", async () => {
    const client: RedisDocumentReindexQueueClient = {
      eval: vi.fn(async () => 1),
      lPop: vi.fn(),
    };
    const queue = createRedisDocumentReindexQueue({ client });
    const job = jobFixture();

    await queue.enqueue(job);

    expect(client.eval).toHaveBeenCalledWith(expect.stringContaining("SADD"), {
      keys: ["iris:reindex:documents:seen", "iris:reindex:documents:queue"],
      arguments: [job.idempotencyKey, serializeDocumentReindexJob(job)],
    });
  });

  it("dequeues jobs in FIFO order up to limit", async () => {
    const first = jobFixture({ documentSnapshotId: "snapshot-1" });
    const second = jobFixture({ documentSnapshotId: "snapshot-2" });
    const client: RedisDocumentReindexQueueClient = {
      eval: vi.fn(),
      lPop: vi
        .fn()
        .mockResolvedValueOnce(serializeDocumentReindexJob(first))
        .mockResolvedValueOnce(serializeDocumentReindexJob(second))
        .mockResolvedValueOnce(null),
    };
    const queue = createRedisDocumentReindexQueue({ client });

    await expect(queue.dequeueBatch(10)).resolves.toEqual([first, second]);
    expect(client.lPop).toHaveBeenCalledTimes(3);
  });

  it("respects dequeue batch limits", async () => {
    const first = jobFixture({ documentSnapshotId: "snapshot-1" });
    const second = jobFixture({ documentSnapshotId: "snapshot-2" });
    const client: RedisDocumentReindexQueueClient = {
      eval: vi.fn(),
      lPop: vi
        .fn()
        .mockResolvedValueOnce(serializeDocumentReindexJob(first))
        .mockResolvedValueOnce(serializeDocumentReindexJob(second)),
    };
    const queue = createRedisDocumentReindexQueue({ client });

    await expect(queue.dequeueBatch(1)).resolves.toEqual([first]);
    expect(client.lPop).toHaveBeenCalledTimes(1);
  });

  it("round-trips job dates through JSON", () => {
    const job = jobFixture();

    expect(parseDocumentReindexJob(serializeDocumentReindexJob(job))).toEqual(job);
  });

  it("rejects malformed queue payloads", () => {
    expect(() => parseDocumentReindexJob("{")).toThrow("Invalid document reindex job JSON");
    expect(() => parseDocumentReindexJob(JSON.stringify({ idempotencyKey: "x" }))).toThrow(
      "Invalid document reindex job payload",
    );
    expect(() =>
      parseDocumentReindexJob(
        JSON.stringify({
          ...jobFixture(),
          reason: "unknown",
          enqueuedAt: "2026-07-02T01:00:00.000Z",
        }),
      ),
    ).toThrow("Invalid document reindex job payload");
  });
});

function jobFixture(overrides: Partial<DocumentReindexJob> = {}): DocumentReindexJob {
  const embeddingProfileId = overrides.embeddingProfileId ?? "profile-1536";
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
