import { randomUUID } from "node:crypto";

import { createClient, type RedisClientType } from "redis";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  createRawEventIdempotencyKey,
  type RawEvent,
} from "../src/events/raw-event-queue.js";
import {
  createRedisRawEventQueue,
  type RedisRawEventQueueClient,
} from "../src/events/redis-raw-event-queue.js";
import {
  createDocumentSyncIdempotencyKey,
  type DocumentSyncJob,
} from "../src/documents/document-sync-queue.js";
import {
  createRedisDocumentSyncQueue,
  type RedisDocumentSyncQueueClient,
} from "../src/documents/redis-document-sync-queue.js";
import {
  createDocumentReindexIdempotencyKey,
  type DocumentReindexJob,
} from "../src/reindex/document-reindex-queue.js";
import {
  createRedisDocumentReindexQueue,
  type RedisDocumentReindexQueueClient,
} from "../src/reindex/redis-document-reindex-queue.js";

const redisUrl = process.env.REDIS_URL?.trim();
const runIfRedis = redisUrl ? describe : describe.skip;

runIfRedis("Redis queue Lua integrations", () => {
  let client: RedisClientType;
  let activeKeys: string[] = [];

  beforeAll(async () => {
    client = createClient({ url: redisUrl });
    client.on("error", () => undefined);
    await client.connect();
  });

  afterEach(async () => {
    if (activeKeys.length > 0) {
      await client.del(activeKeys);
      activeKeys = [];
    }
  });

  afterAll(async () => {
    await client.quit();
  });

  it("runs raw event dedupe, recovery, retry, dead-letter, and replay atomically", async () => {
    const keys = queueKeys("raw");
    activeKeys = Object.values(keys);
    const queue = createRedisRawEventQueue({
      client: client as unknown as RedisRawEventQueueClient,
      ...keys,
      maxAttempts: 2,
      idGenerator: () => "raw-dlq-1",
      now: () => new Date("2026-07-29T08:00:00.000Z"),
    });
    const event: RawEvent = {
      idempotencyKey: createRawEventIdempotencyKey({
        provider: "feishu",
        eventId: "redis-integration",
      }),
      provider: "feishu",
      eventType: "im.message.receive_v1",
      rawBody: { event_id: "redis-integration" },
      receivedAt: new Date("2026-07-29T07:59:00.000Z"),
      attempts: 0,
    };

    await queue.enqueue(event);
    await queue.enqueue(event);
    expect(await queue.getPendingCount()).toBe(1);

    expect(await queue.dequeueBatch(1)).toEqual([event]);
    expect(await queue.dequeueBatch(1)).toEqual([event]);
    expect(await queue.handleFailedEvent({ event, errorMessage: "first failure" })).toEqual({
      action: "requeued",
      attempts: 1,
    });

    const [retried] = await queue.dequeueBatch(1);
    expect(retried?.attempts).toBe(1);
    expect(
      await queue.handleFailedEvent({
        event: retried!,
        errorMessage: "second failure",
      }),
    ).toEqual({ action: "dead_lettered", attempts: 2 });
    expect(await queue.getDeadLetterCount()).toBe(1);

    expect(await queue.replayDeadLetter("raw-dlq-1")).toBe("replayed");
    expect(await queue.getDeadLetterCount()).toBe(0);
    const [replayed] = await queue.dequeueBatch(1);
    expect(replayed?.attempts).toBe(0);
    await queue.handleProcessedEvent(replayed!);

    await queue.enqueue(event);
    expect(await queue.getPendingCount()).toBe(1);
  });

  it("runs document sync recovery, retry, dead-letter, and replay against Redis", async () => {
    const keys = queueKeys("sync");
    activeKeys = Object.values(keys);
    const queue = createRedisDocumentSyncQueue({
      client: client as unknown as RedisDocumentSyncQueueClient,
      ...keys,
      maxAttempts: 2,
      idGenerator: () => "sync-dlq-1",
      now: () => new Date("2026-07-29T08:10:00.000Z"),
    });
    const job: DocumentSyncJob = {
      idempotencyKey: createDocumentSyncIdempotencyKey({
        documentSourceId: "source-redis-integration",
      }),
      documentSourceId: "source-redis-integration",
      reason: "manual_source_sync",
      enqueuedAt: new Date("2026-07-29T08:09:00.000Z"),
      attempts: 0,
    };

    await queue.enqueue(job);
    await queue.enqueue(job);
    expect(await queue.dequeueBatch(1)).toEqual([job]);
    expect(await queue.dequeueBatch(1)).toEqual([job]);
    expect(await queue.handleFailedJob({ job, errorMessage: "first failure" })).toEqual({
      action: "requeued",
      attempts: 1,
    });
    const [retried] = await queue.dequeueBatch(1);
    expect(
      await queue.handleFailedJob({
        job: retried!,
        errorMessage: "second failure",
      }),
    ).toEqual({ action: "dead_lettered", attempts: 2 });

    expect(await queue.replayDeadLetter("sync-dlq-1")).toBe("replayed");
    const [replayed] = await queue.dequeueBatch(1);
    await queue.handleProcessedJob(replayed!);
    expect(await queue.getPendingCount()).toBe(0);
    expect(await queue.getDeadLetterCount()).toBe(0);
  });

  it("runs document reindex recovery, retry, dead-letter, and replay against Redis", async () => {
    const keys = queueKeys("reindex");
    activeKeys = Object.values(keys);
    const queue = createRedisDocumentReindexQueue({
      client: client as unknown as RedisDocumentReindexQueueClient,
      ...keys,
      maxAttempts: 2,
      idGenerator: () => "reindex-dlq-1",
      now: () => new Date("2026-07-29T08:20:00.000Z"),
    });
    const job: DocumentReindexJob = {
      idempotencyKey: createDocumentReindexIdempotencyKey({
        embeddingProfileId: "profile-redis-integration",
        documentSnapshotId: "snapshot-redis-integration",
      }),
      embeddingProfileId: "profile-redis-integration",
      documentSnapshotId: "snapshot-redis-integration",
      reason: "manual_profile_reindex",
      enqueuedAt: new Date("2026-07-29T08:19:00.000Z"),
      attempts: 0,
    };

    await queue.enqueue(job);
    await queue.enqueue(job);
    expect(await queue.dequeueBatch(1)).toEqual([job]);
    expect(await queue.dequeueBatch(1)).toEqual([job]);
    expect(await queue.handleFailedJob({ job, errorMessage: "first failure" })).toEqual({
      action: "requeued",
      attempts: 1,
    });
    const [retried] = await queue.dequeueBatch(1);
    expect(
      await queue.handleFailedJob({
        job: retried!,
        errorMessage: "second failure",
      }),
    ).toEqual({ action: "dead_lettered", attempts: 2 });

    expect(await queue.replayDeadLetter("reindex-dlq-1")).toBe("replayed");
    const [replayed] = await queue.dequeueBatch(1);
    await queue.handleProcessedJob(replayed!);
    expect(await queue.getPendingCount()).toBe(0);
    expect(await queue.getDeadLetterCount()).toBe(0);
  });
});

function queueKeys(kind: string) {
  const prefix = `iris:test:${kind}:${randomUUID()}`;
  return {
    seenKey: `${prefix}:seen`,
    queueKey: `${prefix}:queue`,
    processingKey: `${prefix}:processing`,
    deadLetterKey: `${prefix}:dlq`,
  };
}
