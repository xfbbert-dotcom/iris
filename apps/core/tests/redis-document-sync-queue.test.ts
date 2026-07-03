import { describe, expect, it, vi } from "vitest";

import {
  createDocumentSyncIdempotencyKey,
  type DocumentSyncJob,
} from "../src/documents/document-sync-queue.js";
import {
  createRedisDocumentSyncQueue,
  parseDocumentSyncJob,
  serializeDocumentSyncJob,
  type RedisDocumentSyncQueueClient,
} from "../src/documents/redis-document-sync-queue.js";

describe("RedisDocumentSyncQueue", () => {
  it("atomically enqueues jobs through Redis eval", async () => {
    const client: RedisDocumentSyncQueueClient = {
      eval: vi.fn(async () => 1),
      rPush: vi.fn(),
      lPop: vi.fn(),
      lLen: vi.fn(),
      lRange: vi.fn(),
      lRem: vi.fn(),
    };
    const queue = createRedisDocumentSyncQueue({ client });
    const syncJob = job();

    await queue.enqueue(syncJob);

    expect(client.eval).toHaveBeenCalledWith(expect.stringContaining("SADD"), {
      keys: ["iris:documents:sync:seen", "iris:documents:sync:queue"],
      arguments: [syncJob.idempotencyKey, serializeDocumentSyncJob(syncJob)],
    });
  });

  it("dequeues jobs in FIFO order up to limit", async () => {
    const first = job({ documentSourceId: "source-1" });
    const second = job({ documentSourceId: "source-2" });
    const client: RedisDocumentSyncQueueClient = {
      eval: vi.fn(),
      rPush: vi.fn(),
      lLen: vi.fn(),
      lRange: vi.fn(),
      lRem: vi.fn(),
      lPop: vi
        .fn()
        .mockResolvedValueOnce(serializeDocumentSyncJob(first))
        .mockResolvedValueOnce(serializeDocumentSyncJob(second))
        .mockResolvedValueOnce(null),
    };
    const queue = createRedisDocumentSyncQueue({ client });

    await expect(queue.dequeueBatch(10)).resolves.toEqual([first, second]);
    expect(client.lPop).toHaveBeenCalledTimes(3);
  });

  it("respects dequeue batch limits", async () => {
    const first = job({ documentSourceId: "source-1" });
    const second = job({ documentSourceId: "source-2" });
    const client: RedisDocumentSyncQueueClient = {
      eval: vi.fn(),
      rPush: vi.fn(),
      lLen: vi.fn(),
      lRange: vi.fn(),
      lRem: vi.fn(),
      lPop: vi
        .fn()
        .mockResolvedValueOnce(serializeDocumentSyncJob(first))
        .mockResolvedValueOnce(serializeDocumentSyncJob(second)),
    };
    const queue = createRedisDocumentSyncQueue({ client });

    await expect(queue.dequeueBatch(1)).resolves.toEqual([first]);
    expect(client.lPop).toHaveBeenCalledTimes(1);
  });

  it("round-trips job dates through JSON", () => {
    const syncJob = job();

    expect(parseDocumentSyncJob(serializeDocumentSyncJob(syncJob))).toEqual(syncJob);
  });

  it("normalizes queued job ids when parsing Redis payloads", () => {
    expect(
      parseDocumentSyncJob(
        JSON.stringify({
          idempotencyKey: " document-sync:source-1 ",
          documentSourceId: " source-1 ",
          reason: "discovered_group_document",
          enqueuedAt: "2026-07-03T01:00:00.000Z",
          attempts: 0,
        }),
      ),
    ).toEqual(job());
  });

  it("round-trips manual source sync jobs through JSON", () => {
    const syncJob = job({ reason: "manual_source_sync" });

    expect(parseDocumentSyncJob(serializeDocumentSyncJob(syncJob))).toEqual(syncJob);
  });

  it("reports Redis queue depth", async () => {
    const client: RedisDocumentSyncQueueClient = {
      eval: vi.fn(),
      rPush: vi.fn(),
      lPop: vi.fn(),
      lLen: vi.fn(async () => 42),
      lRange: vi.fn(),
      lRem: vi.fn(),
    };
    const queue = createRedisDocumentSyncQueue({ client });

    await expect(queue.getPendingCount()).resolves.toBe(42);
    expect(client.lLen).toHaveBeenCalledWith("iris:documents:sync:queue");
  });

  it("defaults missing attempts to zero for old queue payloads", () => {
    const { attempts: _attempts, ...legacyJob } = {
      ...job(),
      enqueuedAt: "2026-07-03T01:00:00.000Z",
    };

    expect(parseDocumentSyncJob(JSON.stringify(legacyJob))).toEqual(job());
  });

  it("rejects malformed queue payloads", () => {
    expect(() => parseDocumentSyncJob("{")).toThrow("Invalid document sync job JSON");
    expect(() => parseDocumentSyncJob(JSON.stringify({ idempotencyKey: "x" }))).toThrow(
      "Invalid document sync job payload",
    );
    expect(() =>
      parseDocumentSyncJob(
        JSON.stringify({
          ...job(),
          reason: "unknown",
          enqueuedAt: "2026-07-03T01:00:00.000Z",
        }),
      ),
    ).toThrow("Invalid document sync job payload");
  });

  it("requeues failed jobs below max attempts", async () => {
    const client: RedisDocumentSyncQueueClient = {
      eval: vi.fn(),
      rPush: vi.fn(async () => 1),
      lPop: vi.fn(),
      lLen: vi.fn(),
      lRange: vi.fn(),
      lRem: vi.fn(),
    };
    const queue = createRedisDocumentSyncQueue({ client, maxAttempts: 3 });
    const syncJob = job();

    await expect(
      queue.handleFailedJob({ job: syncJob, errorMessage: "runner crashed" }),
    ).resolves.toEqual({ action: "requeued", attempts: 1 });
    expect(client.rPush).toHaveBeenCalledWith(
      "iris:documents:sync:queue",
      serializeDocumentSyncJob({ ...syncJob, attempts: 1 }),
    );
  });

  it("moves failed jobs to Redis DLQ at max attempts", async () => {
    const client: RedisDocumentSyncQueueClient = {
      eval: vi.fn(),
      rPush: vi.fn(async () => 1),
      lPop: vi.fn(),
      lLen: vi.fn(async () => 5),
      lRange: vi.fn(),
      lRem: vi.fn(),
    };
    const queue = createRedisDocumentSyncQueue({ client, maxAttempts: 3 });
    const syncJob = job({ attempts: 2 });

    await expect(
      queue.handleFailedJob({ job: syncJob, errorMessage: "runner crashed" }),
    ).resolves.toEqual({ action: "dead_lettered", attempts: 3 });
    expect(client.rPush).toHaveBeenCalledWith(
      "iris:documents:sync:dlq",
      expect.stringContaining("runner crashed"),
    );
    await expect(queue.getDeadLetterCount()).resolves.toBe(5);
    expect(client.lLen).toHaveBeenCalledWith("iris:documents:sync:dlq");
  });

  it("stores failed jobs in Redis DLQ with stable ids", async () => {
    const client: RedisDocumentSyncQueueClient = {
      eval: vi.fn(),
      rPush: vi.fn(async () => 1),
      lPop: vi.fn(),
      lLen: vi.fn(),
      lRange: vi.fn(),
      lRem: vi.fn(),
    };
    const queue = createRedisDocumentSyncQueue({
      client,
      maxAttempts: 1,
      now: () => new Date("2026-07-03T02:00:00.000Z"),
      idGenerator: () => "dlq-1",
    });

    await queue.handleFailedJob({ job: job(), errorMessage: "runner crashed" });

    expect(client.rPush).toHaveBeenCalledWith(
      "iris:documents:sync:dlq",
      JSON.stringify({
        id: "dlq-1",
        job: {
          ...job({ attempts: 1 }),
          enqueuedAt: "2026-07-03T01:00:00.000Z",
        },
        errorMessage: "runner crashed",
        failedAt: "2026-07-03T02:00:00.000Z",
      }),
    );
  });

  it("lists Redis DLQ entries and marks legacy entries as non-replayable", async () => {
    const storedPayload = JSON.stringify({
      id: "dlq-1",
      job: {
        ...job({ attempts: 3 }),
        enqueuedAt: "2026-07-03T01:00:00.000Z",
      },
      errorMessage: "runner crashed",
      failedAt: "2026-07-03T02:00:00.000Z",
    });
    const legacyPayload = JSON.stringify({
      job: {
        ...job({ documentSourceId: "source-2", attempts: 3 }),
        enqueuedAt: "2026-07-03T01:00:00.000Z",
      },
      errorMessage: "legacy failure",
      failedAt: "2026-07-03T02:01:00.000Z",
    });
    const client: RedisDocumentSyncQueueClient = {
      eval: vi.fn(),
      rPush: vi.fn(),
      lPop: vi.fn(),
      lLen: vi.fn(),
      lRange: vi.fn(async () => [storedPayload, legacyPayload]),
      lRem: vi.fn(),
    };
    const queue = createRedisDocumentSyncQueue({ client });

    await expect(queue.listDeadLetters({ limit: 2 })).resolves.toEqual([
      {
        id: "dlq-1",
        job: job({ attempts: 3 }),
        errorMessage: "runner crashed",
        failedAt: new Date("2026-07-03T02:00:00.000Z"),
        replayable: true,
      },
      {
        id: expect.stringMatching(/^legacy:1:/),
        job: job({ documentSourceId: "source-2", attempts: 3 }),
        errorMessage: "legacy failure",
        failedAt: new Date("2026-07-03T02:01:00.000Z"),
        replayable: false,
      },
    ]);
    expect(client.lRange).toHaveBeenCalledWith("iris:documents:sync:dlq", 0, 1);
  });

  it("replays Redis DLQ entries with attempts reset", async () => {
    const payload = JSON.stringify({
      id: "dlq-1",
      job: {
        ...job({ attempts: 3 }),
        enqueuedAt: "2026-07-03T01:00:00.000Z",
      },
      errorMessage: "runner crashed",
      failedAt: "2026-07-03T02:00:00.000Z",
    });
    const client: RedisDocumentSyncQueueClient = {
      eval: vi.fn(),
      rPush: vi.fn(async () => 1),
      lPop: vi.fn(),
      lLen: vi.fn(),
      lRange: vi.fn(async () => [payload]),
      lRem: vi.fn(async () => 1),
    };
    const queue = createRedisDocumentSyncQueue({ client });

    await expect(queue.replayDeadLetter("dlq-1")).resolves.toBe("replayed");
    expect(client.lRem).toHaveBeenCalledWith("iris:documents:sync:dlq", 1, payload);
    expect(client.rPush).toHaveBeenCalledWith(
      "iris:documents:sync:queue",
      serializeDocumentSyncJob(job({ attempts: 0 })),
    );
  });

  it("deletes Redis DLQ entries by stable id", async () => {
    const payload = JSON.stringify({
      id: "dlq-1",
      job: {
        ...job({ attempts: 3 }),
        enqueuedAt: "2026-07-03T01:00:00.000Z",
      },
      errorMessage: "runner crashed",
      failedAt: "2026-07-03T02:00:00.000Z",
    });
    const client: RedisDocumentSyncQueueClient = {
      eval: vi.fn(),
      rPush: vi.fn(),
      lPop: vi.fn(),
      lLen: vi.fn(),
      lRange: vi.fn(async () => [payload]),
      lRem: vi.fn(async () => 1),
    };
    const queue = createRedisDocumentSyncQueue({ client });

    await expect(queue.deleteDeadLetter("dlq-1")).resolves.toBe("deleted");
    expect(client.lRem).toHaveBeenCalledWith("iris:documents:sync:dlq", 1, payload);
    expect(client.rPush).not.toHaveBeenCalled();
  });

  it("batch replays Redis DLQ entries and reports missing or legacy ids", async () => {
    const payload = JSON.stringify({
      id: "dlq-1",
      job: {
        ...job({ attempts: 3 }),
        enqueuedAt: "2026-07-03T01:00:00.000Z",
      },
      errorMessage: "runner crashed",
      failedAt: "2026-07-03T02:00:00.000Z",
    });
    const client: RedisDocumentSyncQueueClient = {
      eval: vi.fn(),
      rPush: vi.fn(async () => 1),
      lPop: vi.fn(),
      lLen: vi.fn(),
      lRange: vi.fn(async () => [payload]),
      lRem: vi.fn(async () => 1),
    };
    const queue = createRedisDocumentSyncQueue({ client });

    await expect(
      queue.replayDeadLetters({ ids: ["dlq-1", "missing", "legacy:0:abc"] }),
    ).resolves.toEqual({
      replayedCount: 1,
      notFoundIds: ["missing"],
      unsupportedLegacyIds: ["legacy:0:abc"],
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
