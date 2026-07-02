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
      lPop: vi.fn(),
      lLen: vi.fn(),
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
      lLen: vi.fn(),
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
      lLen: vi.fn(),
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

  it("reports Redis queue depth", async () => {
    const client: RedisDocumentSyncQueueClient = {
      eval: vi.fn(),
      lPop: vi.fn(),
      lLen: vi.fn(async () => 42),
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
