import { randomUUID } from "node:crypto";

import pg from "pg";
import { createClient, type RedisClientType } from "redis";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createFeishuMessageEventProcessor } from "../src/conversation/feishu-message-event-processor.js";
import { createPostgresConversationMessageReplayGuard } from "../src/conversation/conversation-message-replay-guard.js";
import { createPostgresConversationMessageRepository } from "../src/conversation/postgres-conversation-message-repository.js";
import { deleteConversationMessageEvidence } from "../src/conversation-state/conversation-state-evidence-deletion.js";
import { defaultMigrationsDir, runMigrations } from "../src/database/migrate.js";
import { createRedisRawEventQueue } from "../src/events/redis-raw-event-queue.js";
import type { RawEvent } from "../src/events/raw-event-queue.js";
import { createRawEventWorker } from "../src/events/raw-event-worker.js";

const databaseUrl = process.env.IRIS_TEST_DATABASE_URL?.trim();
const redisUrl = process.env.IRIS_TEST_REDIS_URL?.trim();
const runIfServices = databaseUrl && redisUrl ? describe : describe.skip;

runIfServices("deleted Feishu message replay tombstones with Postgres and Redis", () => {
  let pool: pg.Pool;
  let redis: RedisClientType;
  const suitePrefix = `iris:rereview:${randomUUID()}`;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl });
    const client = await pool.connect();
    try {
      await runMigrations({ client, migrationsDir: defaultMigrationsDir() });
    } finally {
      client.release();
    }
    redis = createClient({ url: redisUrl });
    await redis.connect();
  });

  afterAll(async () => {
    const keys = await redis.keys(`${suitePrefix}:*`);
    if (keys.length > 0) await redis.del(keys);
    await redis.quit();
    await pool.end();
  });

  it("suppresses every effect when a deleted provider message is replayed through Redis", async () => {
    const fixture = await deletedMessageFixture("replay");
    const queue = rawQueue("replay");
    const effects = effectSpies();
    const processor = createFeishuMessageEventProcessor({
      messages: createPostgresConversationMessageRepository({ queryable: pool }),
      messageReplayGuard: createPostgresConversationMessageReplayGuard({ dataSource: pool as never }),
      ...effects.dependencies,
    });
    const worker = createRawEventWorker({ queue, processor });

    await queue.enqueue(fixture.event);
    await expect(worker.processBatch({ limit: 1 })).resolves.toMatchObject([{ status: "processed" }]);

    expectSuppressed(effects);
    await expectNoDerivedState(fixture.groupId, fixture.messageId);
    await expect(queue.getPendingCount()).resolves.toBe(0);
    await expect(queue.getDeadLetterCount()).resolves.toBe(0);
  });

  it("suppresses every effect when a deleted provider message is replayed from the DLQ", async () => {
    const fixture = await deletedMessageFixture("dlq");
    const queue = rawQueue("dlq", 1);
    await queue.enqueue(fixture.event);
    const failingWorker = createRawEventWorker({
      queue,
      processor: { process: vi.fn(async () => { throw new Error("forced pre-delete failure"); }) },
    });
    await expect(failingWorker.processBatch({ limit: 1 })).resolves.toMatchObject([{
      status: "failed",
      retryAction: "dead_lettered",
    }]);
    const deadLetters = await queue.listDeadLetters({ limit: 10 });
    expect(deadLetters).toHaveLength(1);
    await expect(queue.replayDeadLetter(deadLetters[0]!.id)).resolves.toBe("replayed");

    const effects = effectSpies();
    const processor = createFeishuMessageEventProcessor({
      messages: createPostgresConversationMessageRepository({ queryable: pool }),
      messageReplayGuard: createPostgresConversationMessageReplayGuard({ dataSource: pool as never }),
      ...effects.dependencies,
    });
    const replayWorker = createRawEventWorker({ queue, processor });
    await expect(replayWorker.processBatch({ limit: 1 })).resolves.toMatchObject([{ status: "processed" }]);

    expectSuppressed(effects);
    await expectNoDerivedState(fixture.groupId, fixture.messageId);
    await expect(queue.getDeadLetterCount()).resolves.toBe(0);
  });

  it("fails closed when deletion wins against an in-flight ingest", async () => {
    const label = `inflight-${randomUUID()}`;
    const groupId = `tombstone-group-${label}`;
    const providerMessageId = `tombstone-message-${label}`;
    const messageId = `feishu:${providerMessageId}`;
    const secret = `deleted in-flight content ${label}`;
    await insertMessage({ groupId, providerMessageId, messageId, secret });

    const beforePhysicalDelete = deferred();
    const allowPhysicalDelete = deferred();
    const deletingDataSource = pausingDeletionDataSource(beforePhysicalDelete.resolve, allowPhysicalDelete.promise);
    const deletionPromise = deleteConversationMessageEvidence({
      dataSource: deletingDataSource,
      groupId,
      messageId,
      operatorHint: "privacy-reviewer",
    });
    await beforePhysicalDelete.promise;

    const effects = effectSpies();
    const processor = createFeishuMessageEventProcessor({
      messages: createPostgresConversationMessageRepository({ queryable: pool }),
      messageReplayGuard: createPostgresConversationMessageReplayGuard({ dataSource: pool as never }),
      ...effects.dependencies,
    });
    const ingestPromise = processor.process(rawEvent({ groupId, providerMessageId, secret, label }));
    await waitForDatabaseLockWait();
    allowPhysicalDelete.resolve();

    await expect(deletionPromise).resolves.toMatchObject({ status: "deleted" });
    await expect(ingestPromise).resolves.toBeUndefined();
    expectSuppressed(effects);
    await expectNoDerivedState(groupId, messageId);
  });

  async function deletedMessageFixture(label: string) {
    const unique = `${label}-${randomUUID()}`;
    const groupId = `tombstone-group-${unique}`;
    const providerMessageId = `tombstone-message-${unique}`;
    const messageId = `feishu:${providerMessageId}`;
    const secret = `deleted replay content ${unique} https://docs.feishu.cn/docx/deleted`;
    await insertMessage({ groupId, providerMessageId, messageId, secret });
    await expect(deleteConversationMessageEvidence({
      dataSource: pool as never,
      groupId,
      messageId,
      operatorHint: "privacy-reviewer",
    })).resolves.toMatchObject({ status: "deleted" });
    return { groupId, providerMessageId, messageId, secret, event: rawEvent({ groupId, providerMessageId, secret, label: unique }) };
  }

  async function insertMessage(input: {
    groupId: string;
    providerMessageId: string;
    messageId: string;
    secret: string;
  }): Promise<void> {
    await pool.query(
      `
      INSERT INTO conversation_messages (
        id, provider, provider_message_id, chat_id, sender_id, sender_open_id,
        message_type, text, sent_at, raw_event_idempotency_key
      ) VALUES ($1, 'feishu', $2, $3, 'ou_deleted', 'ou_deleted',
        'text', $4, NOW(), $5)
      `,
      [input.messageId, input.providerMessageId, input.groupId, input.secret, `seed:${randomUUID()}`],
    );
  }

  function rawQueue(label: string, maxAttempts = 3) {
    const prefix = `${suitePrefix}:${label}:${randomUUID()}`;
    return createRedisRawEventQueue({
      client: redis as never,
      seenKey: `${prefix}:seen`,
      queueKey: `${prefix}:queue`,
      processingKey: `${prefix}:processing`,
      deadLetterKey: `${prefix}:dlq`,
      maxAttempts,
    });
  }

  function pausingDeletionDataSource(signal: () => void, release: Promise<void>) {
    return {
      query<T extends Record<string, unknown> = Record<string, unknown>>(sql: string, values?: unknown[]) {
        return pool.query<T>(sql, values);
      },
      async connect() {
        const client = await pool.connect();
        return {
          async query<T extends Record<string, unknown> = Record<string, unknown>>(sql: string, values?: unknown[]) {
            if (/delete\s+from\s+conversation_messages/iu.test(sql)) {
              signal();
              await release;
            }
            return client.query<T>(sql, values);
          },
          release() {
            client.release();
          },
        };
      },
    };
  }

  async function waitForDatabaseLockWait(): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const result = await pool.query<{ count: number }>(
        `
        SELECT COUNT(*)::int AS count
        FROM pg_stat_activity
        WHERE datname = current_database()
          AND pid <> pg_backend_pid()
          AND wait_event_type = 'Lock'
        `,
      );
      if ((result.rows[0]?.count ?? 0) > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("in-flight ingest did not reach the message serialization boundary");
  }

  async function expectNoDerivedState(groupId: string, messageId: string): Promise<void> {
    const result = await pool.query<Record<string, number>>(
      `
      SELECT
        (SELECT COUNT(*)::int FROM conversation_messages WHERE id = $2) AS message_count,
        (SELECT COUNT(*)::int FROM group_memory_extraction_requests WHERE group_id = $1) AS request_count,
        (SELECT COUNT(*)::int FROM group_memory_extraction_runs WHERE group_id = $1) AS run_count,
        (SELECT COUNT(*)::int FROM discussion_threads WHERE group_id = $1) AS thread_count,
        (SELECT COUNT(*)::int FROM action_items WHERE group_id = $1) AS action_count,
        (SELECT COUNT(*)::int FROM conversation_state_memory_projections WHERE group_id = $1) AS projection_count,
        (SELECT COUNT(*)::int FROM group_memories WHERE group_id = $1) AS memory_count,
        (SELECT COUNT(*)::int FROM document_sources WHERE origin_group_id = $1) AS document_count
      `,
      [groupId, messageId],
    );
    expect(result.rows).toEqual([{
      message_count: 0,
      request_count: 0,
      run_count: 0,
      thread_count: 0,
      action_count: 0,
      projection_count: 0,
      memory_count: 0,
      document_count: 0,
    }]);
  }
});

function effectSpies() {
  const mentionAnswerResponder = {
    maybeRespond: vi.fn(async () => ({ status: "skipped" as const, reason: "not_mentioned" as const })),
  };
  const memoryExtractionPlanner = { registerMessage: vi.fn(async () => undefined) };
  const documentLinkExtractor = {
    extractLinks: vi.fn(() => [{ sourceUri: "https://docs.feishu.cn/docx/deleted" }]),
  };
  const groupVisibleDocumentRegistrar = { registerDiscoveredLinks: vi.fn(async () => undefined) };
  return {
    mentionAnswerResponder,
    memoryExtractionPlanner,
    documentLinkExtractor,
    groupVisibleDocumentRegistrar,
    dependencies: {
      mentionAnswerResponder,
      memoryExtractionPlanner,
      documentLinkExtractor,
      groupVisibleDocumentRegistrar,
    },
  };
}

function expectSuppressed(effects: ReturnType<typeof effectSpies>): void {
  expect(effects.mentionAnswerResponder.maybeRespond).not.toHaveBeenCalled();
  expect(effects.memoryExtractionPlanner.registerMessage).not.toHaveBeenCalled();
  expect(effects.documentLinkExtractor.extractLinks).not.toHaveBeenCalled();
  expect(effects.groupVisibleDocumentRegistrar.registerDiscoveredLinks).not.toHaveBeenCalled();
}

function rawEvent(input: {
  groupId: string;
  providerMessageId: string;
  secret: string;
  label: string;
}): RawEvent {
  return {
    idempotencyKey: `raw-event:feishu:${input.label}`,
    provider: "feishu",
    eventType: "im.message.receive_v1",
    rawBody: {
      header: { event_id: input.label, event_type: "im.message.receive_v1" },
      event: {
        sender: { sender_id: { open_id: "ou_deleted" } },
        message: {
          message_id: input.providerMessageId,
          chat_id: input.groupId,
          message_type: "text",
          content: JSON.stringify({ text: input.secret }),
          create_time: "1782925200000",
        },
      },
    },
    receivedAt: new Date("2026-07-17T00:00:00.000Z"),
    attempts: 0,
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
