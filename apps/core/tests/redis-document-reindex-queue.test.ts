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

  it("normalizes jobs before Redis enqueue and retry upserts", async () => {
    const client: RedisDocumentReindexQueueClient = {
      eval: vi.fn(async () => 1),
      rPush: vi.fn(async () => 1),
      lPop: vi.fn(),
      lLen: vi.fn(),
      lRange: vi.fn(),
      lRem: vi.fn(),
      sRem: vi.fn(),
    };
    const queue = createRedisDocumentReindexQueue({ client, maxAttempts: 3 });
    const job = jobFixture({
      idempotencyKey: " reindex:profile-1536:snapshot-1 ",
      embeddingProfileId: " profile-1536 ",
      documentSnapshotId: " snapshot-1 ",
    });

    await queue.enqueue(job);
    await queue.handleFailedJob({ job, errorMessage: "embedding failed" });

    expect(client.eval).toHaveBeenNthCalledWith(1, expect.stringContaining("SADD"), {
      keys: ["iris:reindex:documents:seen", "iris:reindex:documents:queue"],
      arguments: [jobFixture().idempotencyKey, serializeDocumentReindexJob(jobFixture())],
    });
    expect(client.eval).toHaveBeenNthCalledWith(2, expect.stringContaining("LREM"), {
      keys: [
        "iris:reindex:documents:seen",
        "iris:reindex:documents:queue",
        "iris:reindex:documents:processing",
      ],
      arguments: [
        jobFixture().idempotencyKey,
        serializeDocumentReindexJob(jobFixture({ attempts: 1 })),
        serializeDocumentReindexJob(jobFixture()),
      ],
    });
  });

  it("dequeues jobs in FIFO order up to limit", async () => {
    const first = jobFixture({ documentSnapshotId: "snapshot-1" });
    const second = jobFixture({ documentSnapshotId: "snapshot-2" });
    const client: RedisDocumentReindexQueueClient = {
      eval: vi
        .fn()
        .mockResolvedValueOnce(serializeDocumentReindexJob(first))
        .mockResolvedValueOnce(serializeDocumentReindexJob(second))
        .mockResolvedValueOnce(null),
      rPush: vi.fn(),
      lLen: vi.fn(),
      lRange: vi.fn(),
      lRem: vi.fn(),
      sRem: vi.fn(),
      lPop: vi.fn(),
    };
    const queue = createRedisDocumentReindexQueue({ client });

    await expect(queue.dequeueBatch(10)).resolves.toEqual([first, second]);
    expect(client.eval).toHaveBeenCalledTimes(3);
    expect(client.lPop).not.toHaveBeenCalled();
  });

  it("keeps dequeued job idempotency keys claimed until processing succeeds", async () => {
    const job = jobFixture();
    const client = {
      eval: vi.fn().mockResolvedValueOnce(serializeDocumentReindexJob(job)),
      rPush: vi.fn(),
      lLen: vi.fn(),
      lRange: vi.fn(),
      lRem: vi.fn(),
      sRem: vi.fn(async () => 1),
      lPop: vi.fn(),
    };
    const queue = createRedisDocumentReindexQueue({ client });

    await expect(queue.dequeueBatch(1)).resolves.toEqual([job]);
    expect(client.sRem).not.toHaveBeenCalled();

    await queue.handleProcessedJob(job);

    expect(client.eval).toHaveBeenLastCalledWith(
      expect.stringContaining("SREM"),
      {
        keys: ["iris:reindex:documents:processing", "iris:reindex:documents:seen"],
        arguments: [serializeDocumentReindexJob(job), job.idempotencyKey],
      },
    );
    expect(client.sRem).not.toHaveBeenCalled();
  });

  it("moves dequeued Redis document reindex jobs into the processing list before ACK", async () => {
    const job = jobFixture({ documentSnapshotId: "snapshot-processing" });
    const client: RedisDocumentReindexQueueClient = {
      eval: vi.fn(async () => serializeDocumentReindexJob(job)),
      rPush: vi.fn(),
      lLen: vi.fn(),
      lRange: vi.fn(),
      lRem: vi.fn(),
      sRem: vi.fn(),
      lPop: vi.fn(),
    };
    const queue = createRedisDocumentReindexQueue({ client });

    await expect(queue.dequeueBatch(1)).resolves.toEqual([job]);

    expect(client.eval).toHaveBeenCalledWith(expect.stringContaining("RPUSH"), {
      keys: ["iris:reindex:documents:queue", "iris:reindex:documents:processing"],
      arguments: [],
    });
    expect(client.lPop).not.toHaveBeenCalled();
    expect(client.sRem).not.toHaveBeenCalled();
  });

  it("removes processed Redis document reindex jobs from the processing list on ACK", async () => {
    const job = jobFixture({ documentSnapshotId: "snapshot-processed" });
    const client: RedisDocumentReindexQueueClient = {
      eval: vi.fn(async () => 1),
      rPush: vi.fn(),
      lLen: vi.fn(),
      lRange: vi.fn(),
      lRem: vi.fn(async () => 1),
      sRem: vi.fn(async () => 1),
      lPop: vi.fn(),
    };
    const queue = createRedisDocumentReindexQueue({ client });

    await queue.handleProcessedJob(job);

    expect(client.eval).toHaveBeenCalledWith(
      expect.stringContaining("LREM"),
      {
        keys: ["iris:reindex:documents:processing", "iris:reindex:documents:seen"],
        arguments: [serializeDocumentReindexJob(job), job.idempotencyKey],
      },
    );
    expect(client.eval).toHaveBeenCalledWith(expect.stringContaining("SREM"), expect.anything());
    expect(client.lRem).not.toHaveBeenCalled();
    expect(client.sRem).not.toHaveBeenCalled();
  });

  it("recovers abandoned Redis processing jobs before dequeueing new work", async () => {
    const job = jobFixture({ documentSnapshotId: "snapshot-recovered" });
    const client: RedisDocumentReindexQueueClient = {
      eval: vi
        .fn()
        .mockResolvedValueOnce(1)
        .mockResolvedValueOnce(serializeDocumentReindexJob(job))
        .mockResolvedValueOnce(null),
      rPush: vi.fn(),
      lLen: vi.fn(async (key) => (key === "iris:reindex:documents:processing" ? 1 : 0)),
      lRange: vi.fn(),
      lRem: vi.fn(),
      sRem: vi.fn(),
      lPop: vi.fn(),
    };
    const queue = createRedisDocumentReindexQueue({ client });

    await expect(queue.dequeueBatch(10)).resolves.toEqual([job]);

    expect(client.eval).toHaveBeenNthCalledWith(1, expect.stringContaining("RPOP"), {
      keys: ["iris:reindex:documents:processing", "iris:reindex:documents:queue"],
      arguments: [],
    });
    expect(client.eval).toHaveBeenNthCalledWith(2, expect.stringContaining("LPOP"), {
      keys: ["iris:reindex:documents:queue", "iris:reindex:documents:processing"],
      arguments: [],
    });
  });

  it("respects dequeue batch limits", async () => {
    const first = jobFixture({ documentSnapshotId: "snapshot-1" });
    const second = jobFixture({ documentSnapshotId: "snapshot-2" });
    const client: RedisDocumentReindexQueueClient = {
      eval: vi
        .fn()
        .mockResolvedValueOnce(serializeDocumentReindexJob(first))
        .mockResolvedValueOnce(serializeDocumentReindexJob(second)),
      rPush: vi.fn(),
      lLen: vi.fn(),
      lRange: vi.fn(),
      lRem: vi.fn(),
      sRem: vi.fn(),
      lPop: vi.fn(),
    };
    const queue = createRedisDocumentReindexQueue({ client });

    await expect(queue.dequeueBatch(1)).resolves.toEqual([first]);
    expect(client.eval).toHaveBeenCalledTimes(1);
    expect(client.lPop).not.toHaveBeenCalled();
  });

  it("rejects non-finite dequeue limits before popping Redis jobs", async () => {
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

    await expect(queue.dequeueBatch(Number.POSITIVE_INFINITY)).rejects.toThrow(
      "document reindex queue limit must be a finite safe-magnitude number",
    );
    await expect(queue.dequeueBatch(Number.NaN)).rejects.toThrow(
      "document reindex queue limit must be a finite safe-magnitude number",
    );
    expect(client.lPop).not.toHaveBeenCalled();
    expect(client.eval).not.toHaveBeenCalled();
  });

  it("caps oversized dequeue limits before popping Redis jobs", async () => {
    let nextJob = 0;
    const client: RedisDocumentReindexQueueClient = {
      eval: vi.fn(async () => {
        const current = nextJob;
        nextJob += 1;
        return serializeDocumentReindexJob(
          jobFixture({ documentSnapshotId: `snapshot-${current}` }),
        );
      }),
      rPush: vi.fn(),
      lLen: vi.fn(),
      lRange: vi.fn(),
      lRem: vi.fn(),
      sRem: vi.fn(async () => 1),
      lPop: vi.fn(),
    };
    const queue = createRedisDocumentReindexQueue({ client });

    await expect(queue.dequeueBatch(101)).resolves.toHaveLength(100);

    expect(client.eval).toHaveBeenCalledTimes(100);
    expect(client.lPop).not.toHaveBeenCalled();
  });

  it("rejects unsafe dequeue limits before popping Redis jobs", async () => {
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

    await expect(queue.dequeueBatch(Number.MAX_SAFE_INTEGER + 1)).rejects.toThrow(
      "document reindex queue limit must be a finite safe-magnitude number",
    );
    expect(client.lPop).not.toHaveBeenCalled();
    expect(client.eval).not.toHaveBeenCalled();
  });

  it("dead-letters invalid queued payloads and continues dequeuing valid jobs", async () => {
    const valid = jobFixture({ documentSnapshotId: "snapshot-valid" });
    const client: RedisDocumentReindexQueueClient = {
      eval: vi
        .fn()
        .mockResolvedValueOnce("{")
        .mockResolvedValueOnce(serializeDocumentReindexJob(valid)),
      rPush: vi.fn(async () => 1),
      lLen: vi.fn(),
      lRange: vi.fn(),
      lRem: vi.fn(),
      sRem: vi.fn(),
      lPop: vi.fn(),
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

  it("releases parseable document reindex seen keys for invalid queued payloads", async () => {
    const invalid = {
      ...jobFixture({ documentSnapshotId: "snapshot-invalid" }),
      reason: "unknown",
      enqueuedAt: "2026-07-02T01:00:00.000Z",
    };
    const client: RedisDocumentReindexQueueClient = {
      eval: vi.fn().mockResolvedValueOnce(JSON.stringify(invalid)),
      rPush: vi.fn(async () => 1),
      lLen: vi.fn(),
      lRange: vi.fn(),
      lRem: vi.fn(),
      sRem: vi.fn(async () => 1),
      lPop: vi.fn(),
    };
    const queue = createRedisDocumentReindexQueue({
      client,
      now: () => new Date("2026-07-03T12:35:00.000Z"),
      idGenerator: () => "dlq-invalid-payload",
    });

    await expect(queue.dequeueBatch(1)).resolves.toEqual([]);
    expect(client.sRem).toHaveBeenCalledWith(
      "iris:reindex:documents:seen",
      "reindex:profile-1536:snapshot-invalid",
    );
    expect(client.rPush).toHaveBeenCalledWith(
      "iris:reindex:documents:dlq",
      JSON.stringify({
        id: "dlq-invalid-payload",
        rawPayload: JSON.stringify(invalid),
        errorMessage: "Invalid document reindex job payload",
        failedAt: "2026-07-03T12:35:00.000Z",
      }),
    );
  });

  it("does not release mismatched document reindex seen keys from invalid queued payloads", async () => {
    const invalid = {
      ...jobFixture({ documentSnapshotId: "snapshot-invalid" }),
      idempotencyKey: "reindex:profile-1536:snapshot-1",
      reason: "unknown",
      enqueuedAt: "2026-07-02T01:00:00.000Z",
    };
    const client: RedisDocumentReindexQueueClient = {
      eval: vi.fn().mockResolvedValueOnce(JSON.stringify(invalid)),
      rPush: vi.fn(async () => 1),
      lLen: vi.fn(),
      lRange: vi.fn(),
      lRem: vi.fn(),
      sRem: vi.fn(async () => 1),
      lPop: vi.fn(),
    };
    const queue = createRedisDocumentReindexQueue({
      client,
      now: () => new Date("2026-07-03T12:35:00.000Z"),
      idGenerator: () => "dlq-mismatched-payload",
    });

    await expect(queue.dequeueBatch(1)).resolves.toEqual([]);
    expect(client.sRem).not.toHaveBeenCalled();
    expect(client.rPush).toHaveBeenCalledWith(
      "iris:reindex:documents:dlq",
      JSON.stringify({
        id: "dlq-mismatched-payload",
        rawPayload: JSON.stringify(invalid),
        errorMessage: "Invalid document reindex job payload",
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

  it("rejects oversized document reindex ids before creating idempotency keys", () => {
    expect(() =>
      createDocumentReindexIdempotencyKey({
        embeddingProfileId: "p".repeat(513),
        documentSnapshotId: "snapshot-1",
      }),
    ).toThrow("embeddingProfileId must be at most 512 characters");
    expect(() =>
      createDocumentReindexIdempotencyKey({
        embeddingProfileId: "profile-1536",
        documentSnapshotId: "s".repeat(513),
      }),
    ).toThrow("documentSnapshotId must be at most 512 characters");
  });

  it("rejects oversized queued document reindex identifiers", () => {
    const validPayload = {
      ...jobFixture(),
      enqueuedAt: "2026-07-02T01:00:00.000Z",
    };

    expect(() =>
      parseDocumentReindexJob(
        JSON.stringify({
          ...validPayload,
          idempotencyKey: `reindex:${"p".repeat(513)}:snapshot-1`,
        }),
      ),
    ).toThrow("Invalid document reindex job payload");
    expect(() =>
      parseDocumentReindexJob(
        JSON.stringify({
          ...validPayload,
          embeddingProfileId: "p".repeat(513),
        }),
      ),
    ).toThrow("Invalid document reindex job payload");
    expect(() =>
      parseDocumentReindexJob(
        JSON.stringify({
          ...validPayload,
          documentSnapshotId: "s".repeat(513),
        }),
      ),
    ).toThrow("Invalid document reindex job payload");
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
    expect(client.eval).toHaveBeenCalledWith(expect.stringContaining("LREM"), {
      keys: [
        "iris:reindex:documents:seen",
        "iris:reindex:documents:queue",
        "iris:reindex:documents:processing",
      ],
      arguments: [
        job.idempotencyKey,
        serializeDocumentReindexJob({ ...job, attempts: 1 }),
        serializeDocumentReindexJob(job),
      ],
    });
    expect(client.lRem).not.toHaveBeenCalled();
  });

  it("upgrades a pending duplicate when the in-flight job fails", async () => {
    const job = jobFixture();
    const state = {
      seen: new Set([job.idempotencyKey]),
      queue: [
        serializeDocumentReindexJob({
          ...job,
          enqueuedAt: new Date("2026-07-02T01:05:00.000Z"),
        }),
      ],
    };
    const client: RedisDocumentReindexQueueClient = {
      eval: vi.fn(async (script, options) => {
        if (script.includes("LPOP")) {
          return state.queue.shift() ?? null;
        }

        const [idempotencyKey, payload] = options.arguments;
        if (!state.seen.has(idempotencyKey)) {
          state.seen.add(idempotencyKey);
          state.queue.push(payload);
          return state.queue.length;
        }

        if (script.includes("LSET")) {
          const existingIndex = state.queue.findIndex(
            (queuedPayload) =>
              parseDocumentReindexJob(queuedPayload).idempotencyKey === idempotencyKey,
          );
          if (existingIndex >= 0) {
            state.queue[existingIndex] = payload;
            return 1;
          }
        }

        return 0;
      }),
      rPush: vi.fn(async () => 1),
      lPop: vi.fn(async () => state.queue.shift() ?? null),
      lLen: vi.fn(),
      lRange: vi.fn(),
      lRem: vi.fn(),
      sRem: vi.fn(async (_key, member) => {
        state.seen.delete(member);
        return 1;
      }),
    };
    const queue = createRedisDocumentReindexQueue({ client, maxAttempts: 3 });

    await expect(
      queue.handleFailedJob({ job, errorMessage: "embedding failed" }),
    ).resolves.toEqual({ action: "requeued", attempts: 1 });

    await expect(queue.dequeueBatch(1)).resolves.toEqual([{ ...job, attempts: 1 }]);
  });

  it("rejects unsafe integer max attempts", () => {
    const client: RedisDocumentReindexQueueClient = {
      eval: vi.fn(),
      rPush: vi.fn(),
      lPop: vi.fn(),
      lLen: vi.fn(),
      lRange: vi.fn(),
      lRem: vi.fn(),
      sRem: vi.fn(),
    };

    expect(() => createRedisDocumentReindexQueue({ client, maxAttempts: 9007199254740992 })).toThrow(
      "maxAttempts must be a positive safe integer",
    );
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
    expect(client.eval).toHaveBeenCalledWith(expect.stringContaining("SREM"), {
      keys: ["iris:reindex:documents:dlq", "iris:reindex:documents:processing", "iris:reindex:documents:seen"],
      arguments: [
        expect.stringContaining("embedding failed"),
        serializeDocumentReindexJob(job),
        job.idempotencyKey,
      ],
    });
    expect(client.rPush).not.toHaveBeenCalled();
    expect(client.lRem).not.toHaveBeenCalled();
    expect(client.sRem).not.toHaveBeenCalled();
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

  it("caps oversized Redis DLQ list limits", async () => {
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

    await expect(queue.listDeadLetters({ limit: 101 })).resolves.toEqual([]);

    expect(client.lRange).toHaveBeenCalledWith("iris:reindex:documents:dlq", 0, 99);
  });

  it("rejects non-finite Redis DLQ list limits before reading Redis", async () => {
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

    await expect(queue.listDeadLetters({ limit: Number.POSITIVE_INFINITY })).rejects.toThrow(
      "document reindex queue limit must be a finite safe-magnitude number",
    );
    await expect(queue.listDeadLetters({ limit: Number.NaN })).rejects.toThrow(
      "document reindex queue limit must be a finite safe-magnitude number",
    );
    expect(client.lRange).not.toHaveBeenCalled();
  });

  it("rejects unsafe Redis DLQ list limits before reading Redis", async () => {
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

    await expect(
      queue.listDeadLetters({ limit: Number.MAX_SAFE_INTEGER + 1 }),
    ).rejects.toThrow("document reindex queue limit must be a finite safe-magnitude number");
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

  it("lists corrupt Redis DLQ payloads as non-replayable diagnostics", async () => {
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
      lRange: vi.fn(async () => ["{", payload]),
      lRem: vi.fn(),
      sRem: vi.fn(),
    };
    const queue = createRedisDocumentReindexQueue({
      client,
      now: () => new Date("2026-07-03T13:05:00.000Z"),
    });

    await expect(queue.listDeadLetters({ limit: 2 })).resolves.toEqual([
      {
        id: expect.stringMatching(/^legacy:0:/),
        rawPayload: "{",
        errorMessage: "Invalid document reindex dead letter JSON",
        failedAt: new Date("2026-07-03T13:05:00.000Z"),
        replayable: false,
      },
      {
        id: "dlq-1",
        job: jobFixture({ attempts: 3 }),
        errorMessage: "embedding failed",
        failedAt: new Date("2026-07-02T01:05:00.000Z"),
        replayable: true,
      },
    ]);
  });

  it("deletes malformed Redis DLQ objects with stored ids", async () => {
    const payload = JSON.stringify({
      id: "dlq-malformed",
      rawPayload: 42,
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

    await expect(queue.deleteDeadLetter("dlq-malformed")).resolves.toBe("deleted");
    expect(client.lRem).toHaveBeenCalledWith("iris:reindex:documents:dlq", 1, payload);
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

  it("replays Redis DLQ entries when the seen key is stale", async () => {
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
    const state = {
      seen: new Set([jobFixture().idempotencyKey]),
      queue: [] as string[],
      deadLetters: [payload],
    };
    const client: RedisDocumentReindexQueueClient = {
      eval: vi.fn(async (script, options) => {
        const [idempotencyKey, queuedPayload] = options.arguments;
        if (!state.seen.has(idempotencyKey)) {
          state.seen.add(idempotencyKey);
          state.queue.push(queuedPayload);
          return state.queue.length;
        }

        if (script.includes("LRANGE")) {
          const duplicateIndex = state.queue.findIndex(
            (item) => parseDocumentReindexJob(item).idempotencyKey === idempotencyKey,
          );
          if (duplicateIndex >= 0) {
            state.queue[duplicateIndex] = queuedPayload;
            return 1;
          }

          state.queue.push(queuedPayload);
          return state.queue.length;
        }

        return 0;
      }),
      rPush: vi.fn(),
      lPop: vi.fn(),
      lLen: vi.fn(),
      lRange: vi.fn(async () => state.deadLetters),
      lRem: vi.fn(async (_key, _count, value) => {
        const index = state.deadLetters.indexOf(value);
        if (index === -1) {
          return 0;
        }

        state.deadLetters.splice(index, 1);
        return 1;
      }),
      sRem: vi.fn(),
    };
    const queue = createRedisDocumentReindexQueue({ client });

    await expect(queue.replayDeadLetter("dlq-1")).resolves.toBe("replayed");

    expect(state.queue).toEqual([
      serializeDocumentReindexJob(jobFixture({ attempts: 0 })),
    ]);
    expect(state.deadLetters).toEqual([]);
    expect(client.eval).toHaveBeenCalledWith(expect.stringContaining("LRANGE"), {
      keys: ["iris:reindex:documents:seen", "iris:reindex:documents:queue"],
      arguments: [
        jobFixture().idempotencyKey,
        serializeDocumentReindexJob(jobFixture({ attempts: 0 })),
      ],
    });
  });

  it("keeps Redis DLQ entries when replay enqueue fails", async () => {
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
      eval: vi.fn(async () => {
        throw new Error("redis enqueue unavailable");
      }),
      rPush: vi.fn(),
      lPop: vi.fn(),
      lLen: vi.fn(),
      lRange: vi.fn(async () => [payload]),
      lRem: vi.fn(async () => 1),
      sRem: vi.fn(),
    };
    const queue = createRedisDocumentReindexQueue({ client });

    await expect(queue.replayDeadLetter("dlq-1")).rejects.toThrow(
      "redis enqueue unavailable",
    );
    expect(client.eval).toHaveBeenCalledWith(expect.stringContaining("SADD"), {
      keys: ["iris:reindex:documents:seen", "iris:reindex:documents:queue"],
      arguments: [
        jobFixture().idempotencyKey,
        serializeDocumentReindexJob(jobFixture({ attempts: 0 })),
      ],
    });
    expect(client.lRem).not.toHaveBeenCalled();
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
