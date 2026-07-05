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
      sRem: vi.fn(),
    };
    const queue = createRedisDocumentSyncQueue({ client });
    const syncJob = job();

    await queue.enqueue(syncJob);

    expect(client.eval).toHaveBeenCalledWith(expect.stringContaining("SADD"), {
      keys: ["iris:documents:sync:seen", "iris:documents:sync:queue"],
      arguments: [syncJob.idempotencyKey, serializeDocumentSyncJob(syncJob)],
    });
  });

  it("normalizes jobs before Redis enqueue and retry upserts", async () => {
    const client: RedisDocumentSyncQueueClient = {
      eval: vi.fn(async () => 1),
      rPush: vi.fn(async () => 1),
      lPop: vi.fn(),
      lLen: vi.fn(),
      lRange: vi.fn(),
      lRem: vi.fn(),
      sRem: vi.fn(),
    };
    const queue = createRedisDocumentSyncQueue({ client, maxAttempts: 3 });
    const syncJob = job({
      idempotencyKey: " document-sync:source-1 ",
      documentSourceId: " source-1 ",
    });

    await queue.enqueue(syncJob);
    await queue.handleFailedJob({ job: syncJob, errorMessage: "runner crashed" });

    expect(client.eval).toHaveBeenNthCalledWith(1, expect.stringContaining("SADD"), {
      keys: ["iris:documents:sync:seen", "iris:documents:sync:queue"],
      arguments: [job().idempotencyKey, serializeDocumentSyncJob(job())],
    });
    expect(client.eval).toHaveBeenNthCalledWith(2, expect.stringContaining("SADD"), {
      keys: ["iris:documents:sync:seen", "iris:documents:sync:queue"],
      arguments: [job().idempotencyKey, serializeDocumentSyncJob(job({ attempts: 1 }))],
    });
  });

  it("dequeues jobs in FIFO order up to limit", async () => {
    const first = job({ documentSourceId: "source-1" });
    const second = job({ documentSourceId: "source-2" });
    const client: RedisDocumentSyncQueueClient = {
      eval: vi
        .fn()
        .mockResolvedValueOnce(serializeDocumentSyncJob(first))
        .mockResolvedValueOnce(serializeDocumentSyncJob(second))
        .mockResolvedValueOnce(null),
      rPush: vi.fn(),
      lLen: vi.fn(),
      lRange: vi.fn(),
      lRem: vi.fn(),
      sRem: vi.fn(),
      lPop: vi.fn(),
    };
    const queue = createRedisDocumentSyncQueue({ client });

    await expect(queue.dequeueBatch(10)).resolves.toEqual([first, second]);
    expect(client.eval).toHaveBeenCalledTimes(3);
    expect(client.lPop).not.toHaveBeenCalled();
  });

  it("keeps dequeued job idempotency keys claimed until processing succeeds", async () => {
    const syncJob = job();
    const client = {
      eval: vi.fn().mockResolvedValueOnce(serializeDocumentSyncJob(syncJob)),
      rPush: vi.fn(),
      lLen: vi.fn(),
      lRange: vi.fn(),
      lRem: vi.fn(),
      sRem: vi.fn(async () => 1),
      lPop: vi.fn(),
    };
    const queue = createRedisDocumentSyncQueue({ client });

    await expect(queue.dequeueBatch(1)).resolves.toEqual([syncJob]);
    expect(client.sRem).not.toHaveBeenCalled();

    await queue.handleProcessedJob(syncJob);

    expect(client.sRem).toHaveBeenCalledWith(
      "iris:documents:sync:seen",
      syncJob.idempotencyKey,
    );
  });

  it("moves dequeued Redis document sync jobs into the processing list before ACK", async () => {
    const syncJob = job({ documentSourceId: "source-processing" });
    const client: RedisDocumentSyncQueueClient = {
      eval: vi.fn(async () => serializeDocumentSyncJob(syncJob)),
      rPush: vi.fn(),
      lLen: vi.fn(),
      lRange: vi.fn(),
      lRem: vi.fn(),
      sRem: vi.fn(),
      lPop: vi.fn(),
    };
    const queue = createRedisDocumentSyncQueue({ client });

    await expect(queue.dequeueBatch(1)).resolves.toEqual([syncJob]);

    expect(client.eval).toHaveBeenCalledWith(expect.stringContaining("RPUSH"), {
      keys: ["iris:documents:sync:queue", "iris:documents:sync:processing"],
      arguments: [],
    });
    expect(client.lPop).not.toHaveBeenCalled();
    expect(client.sRem).not.toHaveBeenCalled();
  });

  it("removes processed Redis document sync jobs from the processing list on ACK", async () => {
    const syncJob = job({ documentSourceId: "source-processed" });
    const client: RedisDocumentSyncQueueClient = {
      eval: vi.fn(),
      rPush: vi.fn(),
      lLen: vi.fn(),
      lRange: vi.fn(),
      lRem: vi.fn(async () => 1),
      sRem: vi.fn(async () => 1),
      lPop: vi.fn(),
    };
    const queue = createRedisDocumentSyncQueue({ client });

    await queue.handleProcessedJob(syncJob);

    expect(client.lRem).toHaveBeenCalledWith(
      "iris:documents:sync:processing",
      1,
      serializeDocumentSyncJob(syncJob),
    );
    expect(client.sRem).toHaveBeenCalledWith(
      "iris:documents:sync:seen",
      syncJob.idempotencyKey,
    );
  });

  it("recovers abandoned Redis processing jobs before dequeueing new work", async () => {
    const syncJob = job({ documentSourceId: "source-recovered" });
    const client: RedisDocumentSyncQueueClient = {
      eval: vi
        .fn()
        .mockResolvedValueOnce(1)
        .mockResolvedValueOnce(serializeDocumentSyncJob(syncJob))
        .mockResolvedValueOnce(null),
      rPush: vi.fn(),
      lLen: vi.fn(async (key) => (key === "iris:documents:sync:processing" ? 1 : 0)),
      lRange: vi.fn(),
      lRem: vi.fn(),
      sRem: vi.fn(),
      lPop: vi.fn(),
    };
    const queue = createRedisDocumentSyncQueue({ client });

    await expect(queue.dequeueBatch(10)).resolves.toEqual([syncJob]);

    expect(client.eval).toHaveBeenNthCalledWith(1, expect.stringContaining("RPOP"), {
      keys: ["iris:documents:sync:processing", "iris:documents:sync:queue"],
      arguments: [],
    });
    expect(client.eval).toHaveBeenNthCalledWith(2, expect.stringContaining("LPOP"), {
      keys: ["iris:documents:sync:queue", "iris:documents:sync:processing"],
      arguments: [],
    });
  });

  it("respects dequeue batch limits", async () => {
    const first = job({ documentSourceId: "source-1" });
    const second = job({ documentSourceId: "source-2" });
    const client: RedisDocumentSyncQueueClient = {
      eval: vi
        .fn()
        .mockResolvedValueOnce(serializeDocumentSyncJob(first))
        .mockResolvedValueOnce(serializeDocumentSyncJob(second)),
      rPush: vi.fn(),
      lLen: vi.fn(),
      lRange: vi.fn(),
      lRem: vi.fn(),
      sRem: vi.fn(),
      lPop: vi.fn(),
    };
    const queue = createRedisDocumentSyncQueue({ client });

    await expect(queue.dequeueBatch(1)).resolves.toEqual([first]);
    expect(client.eval).toHaveBeenCalledTimes(1);
    expect(client.lPop).not.toHaveBeenCalled();
  });

  it("rejects non-finite dequeue limits before popping Redis jobs", async () => {
    const client: RedisDocumentSyncQueueClient = {
      eval: vi.fn(),
      rPush: vi.fn(),
      lLen: vi.fn(),
      lRange: vi.fn(),
      lRem: vi.fn(),
      sRem: vi.fn(),
      lPop: vi.fn(async () => null),
    };
    const queue = createRedisDocumentSyncQueue({ client });

    await expect(queue.dequeueBatch(Number.POSITIVE_INFINITY)).rejects.toThrow(
      "document sync queue limit must be a finite safe-magnitude number",
    );
    await expect(queue.dequeueBatch(Number.NaN)).rejects.toThrow(
      "document sync queue limit must be a finite safe-magnitude number",
    );
    expect(client.lPop).not.toHaveBeenCalled();
    expect(client.eval).not.toHaveBeenCalled();
  });

  it("caps oversized dequeue limits before popping Redis jobs", async () => {
    let nextJob = 0;
    const client: RedisDocumentSyncQueueClient = {
      eval: vi.fn(async () => {
        const current = nextJob;
        nextJob += 1;
        return serializeDocumentSyncJob(job({ documentSourceId: `source-${current}` }));
      }),
      rPush: vi.fn(),
      lLen: vi.fn(),
      lRange: vi.fn(),
      lRem: vi.fn(),
      sRem: vi.fn(async () => 1),
      lPop: vi.fn(),
    };
    const queue = createRedisDocumentSyncQueue({ client });

    await expect(queue.dequeueBatch(101)).resolves.toHaveLength(100);

    expect(client.eval).toHaveBeenCalledTimes(100);
    expect(client.lPop).not.toHaveBeenCalled();
  });

  it("rejects unsafe dequeue limits before popping Redis jobs", async () => {
    const client: RedisDocumentSyncQueueClient = {
      eval: vi.fn(),
      rPush: vi.fn(),
      lLen: vi.fn(),
      lRange: vi.fn(),
      lRem: vi.fn(),
      sRem: vi.fn(),
      lPop: vi.fn(async () => null),
    };
    const queue = createRedisDocumentSyncQueue({ client });

    await expect(queue.dequeueBatch(Number.MAX_SAFE_INTEGER + 1)).rejects.toThrow(
      "document sync queue limit must be a finite safe-magnitude number",
    );
    expect(client.lPop).not.toHaveBeenCalled();
    expect(client.eval).not.toHaveBeenCalled();
  });

  it("dead-letters invalid queued payloads and continues dequeuing valid jobs", async () => {
    const valid = job({ documentSourceId: "source-valid" });
    const client: RedisDocumentSyncQueueClient = {
      eval: vi
        .fn()
        .mockResolvedValueOnce("{")
        .mockResolvedValueOnce(serializeDocumentSyncJob(valid)),
      rPush: vi.fn(async () => 1),
      lLen: vi.fn(),
      lRange: vi.fn(),
      lRem: vi.fn(),
      sRem: vi.fn(),
      lPop: vi.fn(),
    };
    const queue = createRedisDocumentSyncQueue({
      client,
      now: () => new Date("2026-07-03T12:30:00.000Z"),
      idGenerator: () => "dlq-invalid",
    });

    await expect(queue.dequeueBatch(2)).resolves.toEqual([valid]);
    expect(client.rPush).toHaveBeenCalledWith(
      "iris:documents:sync:dlq",
      JSON.stringify({
        id: "dlq-invalid",
        rawPayload: "{",
        errorMessage: "Invalid document sync job JSON",
        failedAt: "2026-07-03T12:30:00.000Z",
      }),
    );
  });

  it("releases parseable document sync seen keys for invalid queued payloads", async () => {
    const invalid = {
      ...job({ documentSourceId: "source-invalid" }),
      reason: "unknown",
      enqueuedAt: "2026-07-03T01:00:00.000Z",
    };
    const client: RedisDocumentSyncQueueClient = {
      eval: vi.fn().mockResolvedValueOnce(JSON.stringify(invalid)),
      rPush: vi.fn(async () => 1),
      lLen: vi.fn(),
      lRange: vi.fn(),
      lRem: vi.fn(),
      sRem: vi.fn(async () => 1),
      lPop: vi.fn(),
    };
    const queue = createRedisDocumentSyncQueue({
      client,
      now: () => new Date("2026-07-03T12:30:00.000Z"),
      idGenerator: () => "dlq-invalid-payload",
    });

    await expect(queue.dequeueBatch(1)).resolves.toEqual([]);
    expect(client.sRem).toHaveBeenCalledWith(
      "iris:documents:sync:seen",
      "document-sync:source-invalid",
    );
    expect(client.rPush).toHaveBeenCalledWith(
      "iris:documents:sync:dlq",
      JSON.stringify({
        id: "dlq-invalid-payload",
        rawPayload: JSON.stringify(invalid),
        errorMessage: "Invalid document sync job payload",
        failedAt: "2026-07-03T12:30:00.000Z",
      }),
    );
  });

  it("does not release mismatched document sync seen keys from invalid queued payloads", async () => {
    const invalid = {
      ...job({ documentSourceId: "source-invalid" }),
      idempotencyKey: "document-sync:source-1",
      reason: "unknown",
      enqueuedAt: "2026-07-03T01:00:00.000Z",
    };
    const client: RedisDocumentSyncQueueClient = {
      eval: vi.fn().mockResolvedValueOnce(JSON.stringify(invalid)),
      rPush: vi.fn(async () => 1),
      lLen: vi.fn(),
      lRange: vi.fn(),
      lRem: vi.fn(),
      sRem: vi.fn(async () => 1),
      lPop: vi.fn(),
    };
    const queue = createRedisDocumentSyncQueue({
      client,
      now: () => new Date("2026-07-03T12:30:00.000Z"),
      idGenerator: () => "dlq-mismatched-payload",
    });

    await expect(queue.dequeueBatch(1)).resolves.toEqual([]);
    expect(client.sRem).not.toHaveBeenCalled();
    expect(client.rPush).toHaveBeenCalledWith(
      "iris:documents:sync:dlq",
      JSON.stringify({
        id: "dlq-mismatched-payload",
        rawPayload: JSON.stringify(invalid),
        errorMessage: "Invalid document sync job payload",
        failedAt: "2026-07-03T12:30:00.000Z",
      }),
    );
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

  it("rejects oversized document sync ids before creating idempotency keys", () => {
    expect(() =>
      createDocumentSyncIdempotencyKey({ documentSourceId: "s".repeat(513) }),
    ).toThrow("documentSourceId must be at most 512 characters");
  });

  it("rejects oversized queued document sync identifiers", () => {
    const validPayload = {
      ...job(),
      enqueuedAt: "2026-07-03T01:00:00.000Z",
    };

    expect(() =>
      parseDocumentSyncJob(
        JSON.stringify({
          ...validPayload,
          idempotencyKey: `document-sync:${"s".repeat(513)}`,
        }),
      ),
    ).toThrow("Invalid document sync job payload");
    expect(() =>
      parseDocumentSyncJob(
        JSON.stringify({
          ...validPayload,
          documentSourceId: "s".repeat(513),
        }),
      ),
    ).toThrow("Invalid document sync job payload");
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
      sRem: vi.fn(),
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

  it("rejects unsafe integer document sync attempts", () => {
    expect(() =>
      parseDocumentSyncJob(
        JSON.stringify({
          ...job(),
          enqueuedAt: "2026-07-03T01:00:00.000Z",
          attempts: 9007199254740992,
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
      sRem: vi.fn(),
    };
    const queue = createRedisDocumentSyncQueue({ client, maxAttempts: 3 });
    const syncJob = job();

    await expect(
      queue.handleFailedJob({ job: syncJob, errorMessage: "runner crashed" }),
    ).resolves.toEqual({ action: "requeued", attempts: 1 });
    expect(client.eval).toHaveBeenCalledWith(expect.stringContaining("SADD"), {
      keys: ["iris:documents:sync:seen", "iris:documents:sync:queue"],
      arguments: [
        syncJob.idempotencyKey,
        serializeDocumentSyncJob({ ...syncJob, attempts: 1 }),
      ],
    });
  });

  it("upgrades a pending duplicate when the in-flight job fails", async () => {
    const syncJob = job();
    const state = {
      seen: new Set([syncJob.idempotencyKey]),
      queue: [
        serializeDocumentSyncJob({
          ...syncJob,
          enqueuedAt: new Date("2026-07-03T01:05:00.000Z"),
        }),
      ],
    };
    const client: RedisDocumentSyncQueueClient = {
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
              parseDocumentSyncJob(queuedPayload).idempotencyKey === idempotencyKey,
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
    const queue = createRedisDocumentSyncQueue({ client, maxAttempts: 3 });

    await expect(
      queue.handleFailedJob({ job: syncJob, errorMessage: "sync failed" }),
    ).resolves.toEqual({ action: "requeued", attempts: 1 });

    await expect(queue.dequeueBatch(1)).resolves.toEqual([{ ...syncJob, attempts: 1 }]);
  });

  it("rejects unsafe integer max attempts", () => {
    const client: RedisDocumentSyncQueueClient = {
      eval: vi.fn(),
      rPush: vi.fn(),
      lPop: vi.fn(),
      lLen: vi.fn(),
      lRange: vi.fn(),
      lRem: vi.fn(),
      sRem: vi.fn(),
    };

    expect(() => createRedisDocumentSyncQueue({ client, maxAttempts: 9007199254740992 })).toThrow(
      "maxAttempts must be a positive safe integer",
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
      sRem: vi.fn(),
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
      sRem: vi.fn(),
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
      sRem: vi.fn(),
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

  it("lists invalid raw payload DLQ entries as non-replayable diagnostics", async () => {
    const payload = JSON.stringify({
      id: "dlq-invalid",
      rawPayload: "{",
      errorMessage: "Invalid document sync job JSON",
      failedAt: "2026-07-03T12:30:00.000Z",
    });
    const client: RedisDocumentSyncQueueClient = {
      eval: vi.fn(),
      rPush: vi.fn(),
      lPop: vi.fn(),
      lLen: vi.fn(),
      lRange: vi.fn(async () => [payload]),
      lRem: vi.fn(),
      sRem: vi.fn(),
    };
    const queue = createRedisDocumentSyncQueue({ client });

    await expect(queue.listDeadLetters({ limit: 20 })).resolves.toEqual([
      {
        id: "dlq-invalid",
        rawPayload: "{",
        errorMessage: "Invalid document sync job JSON",
        failedAt: new Date("2026-07-03T12:30:00.000Z"),
        replayable: false,
      },
    ]);
  });

  it("caps oversized Redis DLQ list limits", async () => {
    const client: RedisDocumentSyncQueueClient = {
      eval: vi.fn(),
      rPush: vi.fn(),
      lPop: vi.fn(),
      lLen: vi.fn(),
      lRange: vi.fn(async () => []),
      lRem: vi.fn(),
      sRem: vi.fn(),
    };
    const queue = createRedisDocumentSyncQueue({ client });

    await expect(queue.listDeadLetters({ limit: 101 })).resolves.toEqual([]);

    expect(client.lRange).toHaveBeenCalledWith("iris:documents:sync:dlq", 0, 99);
  });

  it("preserves whitespace-only invalid raw payload DLQ diagnostics", async () => {
    const payload = JSON.stringify({
      id: "dlq-invalid",
      rawPayload: "   ",
      errorMessage: "Invalid document sync job JSON",
      failedAt: "2026-07-03T12:30:00.000Z",
    });
    const client: RedisDocumentSyncQueueClient = {
      eval: vi.fn(),
      rPush: vi.fn(),
      lPop: vi.fn(),
      lLen: vi.fn(),
      lRange: vi.fn(async () => [payload]),
      lRem: vi.fn(),
      sRem: vi.fn(),
    };
    const queue = createRedisDocumentSyncQueue({ client });

    await expect(queue.listDeadLetters({ limit: 20 })).resolves.toEqual([
      {
        id: "dlq-invalid",
        rawPayload: "   ",
        errorMessage: "Invalid document sync job JSON",
        failedAt: new Date("2026-07-03T12:30:00.000Z"),
        replayable: false,
      },
    ]);
  });

  it("lists corrupt Redis DLQ payloads as non-replayable diagnostics", async () => {
    const storedPayload = JSON.stringify({
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
      lRange: vi.fn(async () => ["{", storedPayload]),
      lRem: vi.fn(),
      sRem: vi.fn(),
    };
    const queue = createRedisDocumentSyncQueue({
      client,
      now: () => new Date("2026-07-03T13:00:00.000Z"),
    });

    await expect(queue.listDeadLetters({ limit: 2 })).resolves.toEqual([
      {
        id: expect.stringMatching(/^legacy:0:/),
        rawPayload: "{",
        errorMessage: "Invalid document sync dead letter JSON",
        failedAt: new Date("2026-07-03T13:00:00.000Z"),
        replayable: false,
      },
      {
        id: "dlq-1",
        job: job({ attempts: 3 }),
        errorMessage: "runner crashed",
        failedAt: new Date("2026-07-03T02:00:00.000Z"),
        replayable: true,
      },
    ]);
  });

  it("deletes malformed Redis DLQ objects with stored ids", async () => {
    const payload = JSON.stringify({
      id: "dlq-malformed",
      rawPayload: 42,
      errorMessage: "Invalid document sync job JSON",
      failedAt: "2026-07-03T12:30:00.000Z",
    });
    const client: RedisDocumentSyncQueueClient = {
      eval: vi.fn(),
      rPush: vi.fn(),
      lPop: vi.fn(),
      lLen: vi.fn(),
      lRange: vi.fn(async () => [payload]),
      lRem: vi.fn(async () => 1),
      sRem: vi.fn(),
    };
    const queue = createRedisDocumentSyncQueue({ client });

    await expect(queue.deleteDeadLetter("dlq-malformed")).resolves.toBe("deleted");
    expect(client.lRem).toHaveBeenCalledWith("iris:documents:sync:dlq", 1, payload);
  });

  it("does not replay invalid raw payload DLQ entries", async () => {
    const payload = JSON.stringify({
      id: "dlq-invalid",
      rawPayload: "{",
      errorMessage: "Invalid document sync job JSON",
      failedAt: "2026-07-03T12:30:00.000Z",
    });
    const client: RedisDocumentSyncQueueClient = {
      eval: vi.fn(),
      rPush: vi.fn(),
      lPop: vi.fn(),
      lLen: vi.fn(),
      lRange: vi.fn(async () => [payload]),
      lRem: vi.fn(),
      sRem: vi.fn(),
    };
    const queue = createRedisDocumentSyncQueue({ client });

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
      errorMessage: "Invalid document sync job JSON",
      failedAt: "2026-07-03T12:30:00.000Z",
    });
    const client: RedisDocumentSyncQueueClient = {
      eval: vi.fn(),
      rPush: vi.fn(),
      lPop: vi.fn(),
      lLen: vi.fn(),
      lRange: vi.fn(async () => [payload]),
      lRem: vi.fn(async () => 1),
      sRem: vi.fn(),
    };
    const queue = createRedisDocumentSyncQueue({ client });

    await expect(queue.deleteDeadLetter("dlq-invalid")).resolves.toBe("deleted");
    expect(client.lRem).toHaveBeenCalledWith("iris:documents:sync:dlq", 1, payload);
  });

  it("rejects non-finite Redis DLQ list limits before reading Redis", async () => {
    const client: RedisDocumentSyncQueueClient = {
      eval: vi.fn(),
      rPush: vi.fn(),
      lPop: vi.fn(),
      lLen: vi.fn(),
      lRange: vi.fn(async () => []),
      lRem: vi.fn(),
      sRem: vi.fn(),
    };
    const queue = createRedisDocumentSyncQueue({ client });

    await expect(queue.listDeadLetters({ limit: Number.POSITIVE_INFINITY })).rejects.toThrow(
      "document sync queue limit must be a finite safe-magnitude number",
    );
    await expect(queue.listDeadLetters({ limit: Number.NaN })).rejects.toThrow(
      "document sync queue limit must be a finite safe-magnitude number",
    );
    expect(client.lRange).not.toHaveBeenCalled();
  });

  it("rejects unsafe Redis DLQ list limits before reading Redis", async () => {
    const client: RedisDocumentSyncQueueClient = {
      eval: vi.fn(),
      rPush: vi.fn(),
      lPop: vi.fn(),
      lLen: vi.fn(),
      lRange: vi.fn(async () => []),
      lRem: vi.fn(),
      sRem: vi.fn(),
    };
    const queue = createRedisDocumentSyncQueue({ client });

    await expect(
      queue.listDeadLetters({ limit: Number.MAX_SAFE_INTEGER + 1 }),
    ).rejects.toThrow("document sync queue limit must be a finite safe-magnitude number");
    expect(client.lRange).not.toHaveBeenCalled();
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
      sRem: vi.fn(),
    };
    const queue = createRedisDocumentSyncQueue({ client });

    await expect(queue.replayDeadLetter("dlq-1")).resolves.toBe("replayed");
    expect(client.lRem).toHaveBeenCalledWith("iris:documents:sync:dlq", 1, payload);
    expect(client.eval).toHaveBeenCalledWith(expect.stringContaining("SADD"), {
      keys: ["iris:documents:sync:seen", "iris:documents:sync:queue"],
      arguments: [
        job().idempotencyKey,
        serializeDocumentSyncJob(job({ attempts: 0 })),
      ],
    });
  });

  it("replays Redis DLQ entries when the seen key is stale", async () => {
    const payload = JSON.stringify({
      id: "dlq-1",
      job: {
        ...job({ attempts: 3 }),
        enqueuedAt: "2026-07-03T01:00:00.000Z",
      },
      errorMessage: "runner crashed",
      failedAt: "2026-07-03T02:00:00.000Z",
    });
    const state = {
      seen: new Set([job().idempotencyKey]),
      queue: [] as string[],
      deadLetters: [payload],
    };
    const client: RedisDocumentSyncQueueClient = {
      eval: vi.fn(async (script, options) => {
        const [idempotencyKey, queuedPayload] = options.arguments;
        if (!state.seen.has(idempotencyKey)) {
          state.seen.add(idempotencyKey);
          state.queue.push(queuedPayload);
          return state.queue.length;
        }

        if (script.includes("LRANGE")) {
          const duplicateIndex = state.queue.findIndex(
            (item) => parseDocumentSyncJob(item).idempotencyKey === idempotencyKey,
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
    const queue = createRedisDocumentSyncQueue({ client });

    await expect(queue.replayDeadLetter("dlq-1")).resolves.toBe("replayed");

    expect(state.queue).toEqual([serializeDocumentSyncJob(job({ attempts: 0 }))]);
    expect(state.deadLetters).toEqual([]);
    expect(client.eval).toHaveBeenCalledWith(expect.stringContaining("LRANGE"), {
      keys: ["iris:documents:sync:seen", "iris:documents:sync:queue"],
      arguments: [job().idempotencyKey, serializeDocumentSyncJob(job({ attempts: 0 }))],
    });
  });

  it("keeps Redis DLQ entries when replay enqueue fails", async () => {
    const payload = JSON.stringify({
      id: "dlq-1",
      job: {
        ...job({ attempts: 3 }),
        enqueuedAt: "2026-07-03T01:00:00.000Z",
      },
      errorMessage: "runner crashed",
      failedAt: "2026-07-03T02:00:00.000Z",
    });
    const enqueueError = new Error("redis enqueue unavailable");
    const client: RedisDocumentSyncQueueClient = {
      eval: vi.fn(async () => {
        throw enqueueError;
      }),
      rPush: vi.fn(),
      lPop: vi.fn(),
      lLen: vi.fn(),
      lRange: vi.fn(async () => [payload]),
      lRem: vi.fn(async () => 1),
      sRem: vi.fn(),
    };
    const queue = createRedisDocumentSyncQueue({ client });

    await expect(queue.replayDeadLetter("dlq-1")).rejects.toThrow(
      "redis enqueue unavailable",
    );
    expect(client.eval).toHaveBeenCalledWith(expect.stringContaining("SADD"), {
      keys: ["iris:documents:sync:seen", "iris:documents:sync:queue"],
      arguments: [job().idempotencyKey, serializeDocumentSyncJob(job({ attempts: 0 }))],
    });
    expect(client.lRem).not.toHaveBeenCalled();
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
      sRem: vi.fn(),
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
      sRem: vi.fn(),
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

  it("batch replays Redis DLQ entries without relying on method binding", async () => {
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
      eval: vi.fn(async () => 1),
      rPush: vi.fn(),
      lPop: vi.fn(),
      lLen: vi.fn(),
      lRange: vi.fn(async () => [payload]),
      lRem: vi.fn(async () => 1),
      sRem: vi.fn(),
    };
    const queue = createRedisDocumentSyncQueue({ client });
    const replayDeadLetters = queue.replayDeadLetters;

    await expect(replayDeadLetters({ ids: ["dlq-1"] })).resolves.toEqual({
      replayedCount: 1,
      notFoundIds: [],
      unsupportedLegacyIds: [],
    });
    expect(client.eval).toHaveBeenCalledWith(expect.stringContaining("SADD"), {
      keys: ["iris:documents:sync:seen", "iris:documents:sync:queue"],
      arguments: [job().idempotencyKey, serializeDocumentSyncJob(job({ attempts: 0 }))],
    });
  });

  it("deduplicates repeated ids in Redis batch replay requests", async () => {
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
      eval: vi.fn(async () => 1),
      rPush: vi.fn(),
      lPop: vi.fn(),
      lLen: vi.fn(),
      lRange: vi.fn(async () => [payload]),
      lRem: vi.fn(async () => 1),
      sRem: vi.fn(),
    };
    const queue = createRedisDocumentSyncQueue({ client });

    await expect(queue.replayDeadLetters({ ids: ["dlq-1", "dlq-1"] })).resolves.toEqual({
      replayedCount: 1,
      notFoundIds: [],
      unsupportedLegacyIds: [],
    });
    expect(client.eval).toHaveBeenCalledOnce();
    expect(client.lRem).toHaveBeenCalledOnce();
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
