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
      rPush: vi.fn(),
      lPop: vi.fn(),
      lLen: vi.fn(),
      lRange: vi.fn(),
      lRem: vi.fn(),
      sRem: vi.fn(),
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
      rPush: vi.fn(),
      lLen: vi.fn(),
      lRange: vi.fn(),
      lRem: vi.fn(),
      sRem: vi.fn(),
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

  it("releases dequeued job idempotency keys from the Redis seen set", async () => {
    const job = jobFixture();
    const client = {
      eval: vi.fn(),
      rPush: vi.fn(),
      lLen: vi.fn(),
      lRange: vi.fn(),
      lRem: vi.fn(),
      sRem: vi.fn(async () => 1),
      lPop: vi.fn().mockResolvedValueOnce(serializeDocumentReindexJob(job)),
    };
    const queue = createRedisDocumentReindexQueue({ client });

    await expect(queue.dequeueBatch(1)).resolves.toEqual([job]);
    expect(client.sRem).toHaveBeenCalledWith(
      "iris:reindex:documents:seen",
      job.idempotencyKey,
    );
  });

  it("respects dequeue batch limits", async () => {
    const first = jobFixture({ documentSnapshotId: "snapshot-1" });
    const second = jobFixture({ documentSnapshotId: "snapshot-2" });
    const client: RedisDocumentReindexQueueClient = {
      eval: vi.fn(),
      rPush: vi.fn(),
      lLen: vi.fn(),
      lRange: vi.fn(),
      lRem: vi.fn(),
      sRem: vi.fn(),
      lPop: vi
        .fn()
        .mockResolvedValueOnce(serializeDocumentReindexJob(first))
        .mockResolvedValueOnce(serializeDocumentReindexJob(second)),
    };
    const queue = createRedisDocumentReindexQueue({ client });

    await expect(queue.dequeueBatch(1)).resolves.toEqual([first]);
    expect(client.lPop).toHaveBeenCalledTimes(1);
  });

  it("treats non-finite dequeue limits as zero", async () => {
    const client: RedisDocumentReindexQueueClient = {
      eval: vi.fn(),
      rPush: vi.fn(),
      lLen: vi.fn(),
      lRange: vi.fn(),
      lRem: vi.fn(),
      sRem: vi.fn(),
      lPop: vi.fn(async () => null),
    };
    const queue = createRedisDocumentReindexQueue({ client });

    await expect(queue.dequeueBatch(Number.POSITIVE_INFINITY)).resolves.toEqual([]);
    await expect(queue.dequeueBatch(Number.NaN)).resolves.toEqual([]);
    expect(client.lPop).not.toHaveBeenCalled();
  });

  it("dead-letters invalid queued payloads and continues dequeuing valid jobs", async () => {
    const valid = jobFixture({ documentSnapshotId: "snapshot-valid" });
    const client: RedisDocumentReindexQueueClient = {
      eval: vi.fn(),
      rPush: vi.fn(async () => 1),
      lLen: vi.fn(),
      lRange: vi.fn(),
      lRem: vi.fn(),
      sRem: vi.fn(),
      lPop: vi
        .fn()
        .mockResolvedValueOnce("{")
        .mockResolvedValueOnce(serializeDocumentReindexJob(valid)),
    };
    const queue = createRedisDocumentReindexQueue({
      client,
      now: () => new Date("2026-07-03T12:35:00.000Z"),
      idGenerator: () => "dlq-invalid",
    });

    await expect(queue.dequeueBatch(2)).resolves.toEqual([valid]);
    expect(client.rPush).toHaveBeenCalledWith(
      "iris:reindex:documents:dlq",
      JSON.stringify({
        id: "dlq-invalid",
        rawPayload: "{",
        errorMessage: "Invalid document reindex job JSON",
        failedAt: "2026-07-03T12:35:00.000Z",
      }),
    );
  });

  it("round-trips job dates through JSON", () => {
    const job = jobFixture();

    expect(parseDocumentReindexJob(serializeDocumentReindexJob(job))).toEqual(job);
  });

  it("normalizes queued job ids when parsing Redis payloads", () => {
    expect(
      parseDocumentReindexJob(
        JSON.stringify({
          idempotencyKey: " reindex:profile-1536:snapshot-1 ",
          embeddingProfileId: " profile-1536 ",
          documentSnapshotId: " snapshot-1 ",
          reason: "manual_profile_reindex",
          enqueuedAt: "2026-07-02T01:00:00.000Z",
          attempts: 0,
        }),
      ),
    ).toEqual(jobFixture());
  });

  it("reports Redis queue depth", async () => {
    const client: RedisDocumentReindexQueueClient = {
      eval: vi.fn(),
      rPush: vi.fn(),
      lPop: vi.fn(),
      lLen: vi.fn(async () => 42),
      lRange: vi.fn(),
      lRem: vi.fn(),
      sRem: vi.fn(),
    };
    const queue = createRedisDocumentReindexQueue({ client });

    await expect(queue.getPendingCount()).resolves.toBe(42);
    expect(client.lLen).toHaveBeenCalledWith("iris:reindex:documents:queue");
  });

  it("defaults missing attempts to zero for old queue payloads", () => {
    const { attempts: _attempts, ...legacyJob } = jobFixture();

    expect(parseDocumentReindexJob(JSON.stringify(legacyJob))).toEqual(jobFixture());
  });

  it("requeues failed jobs below max attempts", async () => {
    const client: RedisDocumentReindexQueueClient = {
      eval: vi.fn(),
      rPush: vi.fn(async () => 1),
      lPop: vi.fn(),
      lLen: vi.fn(),
      lRange: vi.fn(),
      lRem: vi.fn(),
      sRem: vi.fn(),
    };
    const queue = createRedisDocumentReindexQueue({ client, maxAttempts: 3 });
    const job = jobFixture();

    await expect(
      queue.handleFailedJob({ job, errorMessage: "embedding failed" }),
    ).resolves.toEqual({ action: "requeued", attempts: 1 });
    expect(client.eval).toHaveBeenCalledWith(expect.stringContaining("SADD"), {
      keys: ["iris:reindex:documents:seen", "iris:reindex:documents:queue"],
      arguments: [
        job.idempotencyKey,
        serializeDocumentReindexJob({ ...job, attempts: 1 }),
      ],
    });
  });

  it("moves failed jobs to Redis DLQ at max attempts", async () => {
    const client: RedisDocumentReindexQueueClient = {
      eval: vi.fn(),
      rPush: vi.fn(async () => 1),
      lPop: vi.fn(),
      lLen: vi.fn(async () => 5),
      lRange: vi.fn(),
      lRem: vi.fn(),
      sRem: vi.fn(),
    };
    const queue = createRedisDocumentReindexQueue({ client, maxAttempts: 3 });
    const job = jobFixture({ attempts: 2 });

    await expect(
      queue.handleFailedJob({ job, errorMessage: "embedding failed" }),
    ).resolves.toEqual({ action: "dead_lettered", attempts: 3 });
    expect(client.rPush).toHaveBeenCalledWith(
      "iris:reindex:documents:dlq",
      expect.stringContaining("embedding failed"),
    );
    await expect(queue.getDeadLetterCount()).resolves.toBe(5);
    expect(client.lLen).toHaveBeenCalledWith("iris:reindex:documents:dlq");
  });

  it("lists Redis DLQ entries", async () => {
    const deadLetter = {
      id: "dlq-1",
      job: {
        ...jobFixture({ attempts: 3 }),
        enqueuedAt: "2026-07-02T01:00:00.000Z",
      },
      errorMessage: "embedding failed",
      failedAt: "2026-07-02T01:05:00.000Z",
    };
    const client: RedisDocumentReindexQueueClient = {
      eval: vi.fn(),
      rPush: vi.fn(),
      lPop: vi.fn(),
      lLen: vi.fn(),
      lRange: vi.fn(async () => [JSON.stringify(deadLetter)]),
      lRem: vi.fn(),
      sRem: vi.fn(),
    };
    const queue = createRedisDocumentReindexQueue({ client });

    await expect(queue.listDeadLetters({ limit: 20 })).resolves.toEqual([
      {
        id: "dlq-1",
        job: jobFixture({ attempts: 3 }),
        errorMessage: "embedding failed",
        failedAt: new Date("2026-07-02T01:05:00.000Z"),
        replayable: true,
      },
    ]);
    expect(client.lRange).toHaveBeenCalledWith("iris:reindex:documents:dlq", 0, 19);
  });

  it("treats non-finite Redis DLQ list limits as zero", async () => {
    const client: RedisDocumentReindexQueueClient = {
      eval: vi.fn(),
      rPush: vi.fn(),
      lPop: vi.fn(),
      lLen: vi.fn(),
      lRange: vi.fn(async () => []),
      lRem: vi.fn(),
      sRem: vi.fn(),
    };
    const queue = createRedisDocumentReindexQueue({ client });

    await expect(queue.listDeadLetters({ limit: Number.POSITIVE_INFINITY })).resolves.toEqual([]);
    await expect(queue.listDeadLetters({ limit: Number.NaN })).resolves.toEqual([]);
    expect(client.lRange).not.toHaveBeenCalled();
  });

  it("lists legacy Redis DLQ entries as not replayable", async () => {
    const legacy = {
      job: {
        ...jobFixture({ attempts: 3 }),
        enqueuedAt: "2026-07-02T01:00:00.000Z",
      },
      errorMessage: "embedding failed",
      failedAt: "2026-07-02T01:05:00.000Z",
    };
    const client: RedisDocumentReindexQueueClient = {
      eval: vi.fn(),
      rPush: vi.fn(),
      lPop: vi.fn(),
      lLen: vi.fn(),
      lRange: vi.fn(async () => [JSON.stringify(legacy)]),
      lRem: vi.fn(),
      sRem: vi.fn(),
    };
    const queue = createRedisDocumentReindexQueue({ client });

    const [item] = await queue.listDeadLetters({ limit: 20 });
    expect(item.replayable).toBe(false);
    expect(item.id).toMatch(/^legacy:/);
  });

  it("lists invalid raw payload DLQ entries as non-replayable diagnostics", async () => {
    const payload = JSON.stringify({
      id: "dlq-invalid",
      rawPayload: "{",
      errorMessage: "Invalid document reindex job JSON",
      failedAt: "2026-07-03T12:35:00.000Z",
    });
    const client: RedisDocumentReindexQueueClient = {
      eval: vi.fn(),
      rPush: vi.fn(),
      lPop: vi.fn(),
      lLen: vi.fn(),
      lRange: vi.fn(async () => [payload]),
      lRem: vi.fn(),
      sRem: vi.fn(),
    };
    const queue = createRedisDocumentReindexQueue({ client });

    await expect(queue.listDeadLetters({ limit: 20 })).resolves.toEqual([
      {
        id: "dlq-invalid",
        rawPayload: "{",
        errorMessage: "Invalid document reindex job JSON",
        failedAt: new Date("2026-07-03T12:35:00.000Z"),
        replayable: false,
      },
    ]);
  });

  it("preserves empty invalid raw payload DLQ diagnostics", async () => {
    const payload = JSON.stringify({
      id: "dlq-invalid",
      rawPayload: "",
      errorMessage: "Invalid document reindex job JSON",
      failedAt: "2026-07-03T12:35:00.000Z",
    });
    const client: RedisDocumentReindexQueueClient = {
      eval: vi.fn(),
      rPush: vi.fn(),
      lPop: vi.fn(),
      lLen: vi.fn(),
      lRange: vi.fn(async () => [payload]),
      lRem: vi.fn(),
      sRem: vi.fn(),
    };
    const queue = createRedisDocumentReindexQueue({ client });

    await expect(queue.listDeadLetters({ limit: 20 })).resolves.toEqual([
      {
        id: "dlq-invalid",
        rawPayload: "",
        errorMessage: "Invalid document reindex job JSON",
        failedAt: new Date("2026-07-03T12:35:00.000Z"),
        replayable: false,
      },
    ]);
  });

  it("does not replay invalid raw payload DLQ entries", async () => {
    const payload = JSON.stringify({
      id: "dlq-invalid",
      rawPayload: "{",
      errorMessage: "Invalid document reindex job JSON",
      failedAt: "2026-07-03T12:35:00.000Z",
    });
    const client: RedisDocumentReindexQueueClient = {
      eval: vi.fn(),
      rPush: vi.fn(),
      lPop: vi.fn(),
      lLen: vi.fn(),
      lRange: vi.fn(async () => [payload]),
      lRem: vi.fn(),
      sRem: vi.fn(),
    };
    const queue = createRedisDocumentReindexQueue({ client });

    await expect(queue.replayDeadLetter("dlq-invalid")).resolves.toBe(
      "unsupported_legacy_item",
    );
    expect(client.lRem).not.toHaveBeenCalled();
    expect(client.rPush).not.toHaveBeenCalled();
  });

  it("deletes invalid raw payload DLQ entries by stable id", async () => {
    const payload = JSON.stringify({
      id: "dlq-invalid",
      rawPayload: "{",
      errorMessage: "Invalid document reindex job JSON",
      failedAt: "2026-07-03T12:35:00.000Z",
    });
    const client: RedisDocumentReindexQueueClient = {
      eval: vi.fn(),
      rPush: vi.fn(),
      lPop: vi.fn(),
      lLen: vi.fn(),
      lRange: vi.fn(async () => [payload]),
      lRem: vi.fn(async () => 1),
      sRem: vi.fn(),
    };
    const queue = createRedisDocumentReindexQueue({ client });

    await expect(queue.deleteDeadLetter("dlq-invalid")).resolves.toBe("deleted");
    expect(client.lRem).toHaveBeenCalledWith("iris:reindex:documents:dlq", 1, payload);
  });

  it("replays Redis DLQ entries with attempts reset", async () => {
    const deadLetter = {
      id: "dlq-1",
      job: {
        ...jobFixture({ attempts: 3 }),
        enqueuedAt: "2026-07-02T01:00:00.000Z",
      },
      errorMessage: "embedding failed",
      failedAt: "2026-07-02T01:05:00.000Z",
    };
    const payload = JSON.stringify(deadLetter);
    const client: RedisDocumentReindexQueueClient = {
      eval: vi.fn(),
      rPush: vi.fn(async () => 1),
      lPop: vi.fn(),
      lLen: vi.fn(),
      lRange: vi.fn(async () => [payload]),
      lRem: vi.fn(async () => 1),
      sRem: vi.fn(),
    };
    const queue = createRedisDocumentReindexQueue({ client });

    await expect(queue.replayDeadLetter("dlq-1")).resolves.toBe("replayed");
    expect(client.lRem).toHaveBeenCalledWith("iris:reindex:documents:dlq", 1, payload);
    expect(client.eval).toHaveBeenCalledWith(expect.stringContaining("SADD"), {
      keys: ["iris:reindex:documents:seen", "iris:reindex:documents:queue"],
      arguments: [
        jobFixture().idempotencyKey,
        serializeDocumentReindexJob(jobFixture({ attempts: 0 })),
      ],
    });
  });

  it("deletes Redis DLQ entries", async () => {
    const deadLetter = {
      id: "dlq-1",
      job: {
        ...jobFixture({ attempts: 3 }),
        enqueuedAt: "2026-07-02T01:00:00.000Z",
      },
      errorMessage: "embedding failed",
      failedAt: "2026-07-02T01:05:00.000Z",
    };
    const payload = JSON.stringify(deadLetter);
    const client: RedisDocumentReindexQueueClient = {
      eval: vi.fn(),
      rPush: vi.fn(),
      lPop: vi.fn(),
      lLen: vi.fn(),
      lRange: vi.fn(async () => [payload]),
      lRem: vi.fn(async () => 1),
      sRem: vi.fn(),
    };
    const queue = createRedisDocumentReindexQueue({ client });

    await expect(queue.deleteDeadLetter("dlq-1")).resolves.toBe("deleted");
    expect(client.lRem).toHaveBeenCalledWith("iris:reindex:documents:dlq", 1, payload);
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

  it("rejects unsafe integer document reindex attempts", () => {
    expect(() =>
      parseDocumentReindexJob(
        JSON.stringify({
          ...jobFixture(),
          enqueuedAt: "2026-07-02T01:00:00.000Z",
          attempts: 9007199254740992,
        }),
      ),
    ).toThrow("Invalid document reindex job payload");
  });

  it("batch replays Redis DLQ entries without relying on method binding", async () => {
    const deadLetter = {
      id: "dlq-1",
      job: {
        ...jobFixture({ attempts: 3 }),
        enqueuedAt: "2026-07-02T01:00:00.000Z",
      },
      errorMessage: "embedding failed",
      failedAt: "2026-07-02T01:05:00.000Z",
    };
    const payload = JSON.stringify(deadLetter);
    const client: RedisDocumentReindexQueueClient = {
      eval: vi.fn(async () => 1),
      rPush: vi.fn(),
      lPop: vi.fn(),
      lLen: vi.fn(),
      lRange: vi.fn(async () => [payload]),
      lRem: vi.fn(async () => 1),
      sRem: vi.fn(),
    };
    const queue = createRedisDocumentReindexQueue({ client });
    const replayDeadLetters = queue.replayDeadLetters;

    await expect(replayDeadLetters({ ids: ["dlq-1"] })).resolves.toEqual({
      replayedCount: 1,
      notFoundIds: [],
      unsupportedLegacyIds: [],
    });
    expect(client.eval).toHaveBeenCalledWith(expect.stringContaining("SADD"), {
      keys: ["iris:reindex:documents:seen", "iris:reindex:documents:queue"],
      arguments: [
        jobFixture().idempotencyKey,
        serializeDocumentReindexJob(jobFixture({ attempts: 0 })),
      ],
    });
  });

  it("deduplicates repeated ids in Redis batch replay requests", async () => {
    const deadLetter = {
      id: "dlq-1",
      job: {
        ...jobFixture({ attempts: 3 }),
        enqueuedAt: "2026-07-02T01:00:00.000Z",
      },
      errorMessage: "embedding failed",
      failedAt: "2026-07-02T01:05:00.000Z",
    };
    const payload = JSON.stringify(deadLetter);
    const client: RedisDocumentReindexQueueClient = {
      eval: vi.fn(async () => 1),
      rPush: vi.fn(),
      lPop: vi.fn(),
      lLen: vi.fn(),
      lRange: vi.fn(async () => [payload]),
      lRem: vi.fn(async () => 1),
      sRem: vi.fn(),
    };
    const queue = createRedisDocumentReindexQueue({ client });

    await expect(queue.replayDeadLetters({ ids: ["dlq-1", "dlq-1"] })).resolves.toEqual({
      replayedCount: 1,
      notFoundIds: [],
      unsupportedLegacyIds: [],
    });
    expect(client.eval).toHaveBeenCalledOnce();
    expect(client.lRem).toHaveBeenCalledOnce();
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
    attempts: 0,
    ...overrides,
  };
}
