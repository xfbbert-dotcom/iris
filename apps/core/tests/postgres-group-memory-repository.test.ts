import { createHash, randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { defaultMigrationsDir, runMigrations } from "../src/database/migrate.js";
import { GroupMemoryIdempotencyConflictError } from "../src/memory/group-memory-repository.js";
import { createGroupMemoryService } from "../src/memory/group-memory-service.js";
import { createGroupMemoryContextProvider } from "../src/memory/group-memory-context-provider.js";
import {
  insertGroupMemoryWithEvidence,
  lockGroupMemoryWriteScope,
} from "../src/memory/postgres-group-memory-writer.js";
import { createConversationStateProjector } from "../src/conversation-state/conversation-state-projector.js";
import { createPostgresConversationStateRepository } from "../src/conversation-state/postgres-conversation-state-repository.js";

import {
  createPostgresGroupMemoryRepository,
  type PostgresGroupMemoryDataSource,
  type Queryable,
  type TransactionClient,
} from "../src/memory/postgres-group-memory-repository.js";

const databaseUrl = process.env.IRIS_TEST_DATABASE_URL?.trim();
const runIfDatabase = databaseUrl ? describe : describe.skip;

describe("createPostgresGroupMemoryRepository", () => {
  it("exposes the same insertion and evidence checks through a transaction-scoped writer", async () => {
    const client = scriptedClient([
      step(/from group_memories[\s\S]+idempotency_key/u, []),
      step(/from conversation_messages/u, [
        { id: "feishu:msg-1", chat_id: "chat-a" },
        { id: "feishu:msg-2", chat_id: "chat-a" },
      ]),
      step(/insert into group_memories/u, [memoryRow()]),
      step(/insert into group_memory_message_evidence/u),
    ]);

    await expect(
      insertGroupMemoryWithEvidence({
        queryable: client,
        memory: { id: "memory-1", ...createInput() },
      }),
    ).resolves.toEqual(expectedMemory());

    expect(normalizedCalls(client)).not.toEqual(
      expect.arrayContaining(["begin", "commit", "rollback"]),
    );
  });

  it("creates an evidence-bound memory transactionally", async () => {
    const client = scriptedClient([
      step(/begin/u),
      step(/pg_advisory_xact_lock/u),
      step(/from group_memories[\s\S]+idempotency_key/u, []),
      step(/from conversation_messages/u, [
        { id: "feishu:msg-1", chat_id: "chat-a" },
        { id: "feishu:msg-2", chat_id: "chat-a" },
      ]),
      step(/insert into group_memories/u, [memoryRow()]),
      step(/insert into group_memory_message_evidence/u),
      step(/commit/u),
    ]);
    const repository = createPostgresGroupMemoryRepository({
      dataSource: dataSource(client),
    });

    await expect(repository.create(createInput())).resolves.toEqual({
      created: true,
      memory: expectedMemory(),
    });
    expect(client.release).toHaveBeenCalledOnce();
    expect(client.query).toHaveBeenCalledWith(
      expect.stringMatching(/insert into group_memory_message_evidence/iu),
      ["memory-1", ["feishu:msg-1", "feishu:msg-2"]],
    );
  });

  it("returns the existing memory for a duplicate group idempotency key", async () => {
    const client = scriptedClient([
      step(/begin/u),
      step(/pg_advisory_xact_lock/u),
      step(/from group_memories[\s\S]+idempotency_key/u, [memoryRow()]),
      step(/commit/u),
    ]);
    const repository = createPostgresGroupMemoryRepository({
      dataSource: dataSource(client),
    });

    await expect(repository.create(createInput())).resolves.toEqual({
      created: false,
      memory: expectedMemory(),
    });
    expect(normalizedCalls(client)).not.toEqual(
      expect.arrayContaining([expect.stringContaining("insert into group_memories")]),
    );
  });

  it("rejects a create idempotency key reused with a different request", async () => {
    const client = scriptedClient([
      step(/begin/u),
      step(/pg_advisory_xact_lock/u),
      step(/from group_memories[\s\S]+idempotency_key/u, [
        memoryRow({ content: "Different content" }),
      ]),
      step(/rollback/u),
    ]);
    const repository = createPostgresGroupMemoryRepository({
      dataSource: dataSource(client),
    });

    await expect(repository.create(createInput())).rejects.toBeInstanceOf(
      GroupMemoryIdempotencyConflictError,
    );
    expect(normalizedCalls(client)).not.toEqual(
      expect.arrayContaining([expect.stringContaining("insert into group_memories")]),
    );
  });

  it("rejects missing evidence before opening a transaction", async () => {
    const source = dataSource(scriptedClient([]));
    const repository = createPostgresGroupMemoryRepository({ dataSource: source });

    await expect(
      repository.create({ ...createInput(), evidenceMessageIds: [] }),
    ).rejects.toThrow("evidenceMessageIds must not be empty");
    expect(source.connect).not.toHaveBeenCalled();
  });

  it("rolls back when evidence belongs to another group", async () => {
    const client = scriptedClient([
      step(/begin/u),
      step(/pg_advisory_xact_lock/u),
      step(/from group_memories[\s\S]+idempotency_key/u, []),
      step(/from conversation_messages/u, [
        { id: "feishu:msg-1", chat_id: "chat-b" },
        { id: "feishu:msg-2", chat_id: "chat-a" },
      ]),
      step(/rollback/u),
    ]);
    const repository = createPostgresGroupMemoryRepository({
      dataSource: dataSource(client),
    });

    await expect(repository.create(createInput())).rejects.toThrow(
      "memory evidence must belong to the same group",
    );
    expect(normalizedCalls(client)).not.toEqual(
      expect.arrayContaining([expect.stringContaining("insert into group_memories")]),
    );
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("lists only active memories for the requested group with a bounded limit", async () => {
    const source = dataSource(scriptedClient([]), [memoryRow()]);
    const repository = createPostgresGroupMemoryRepository({ dataSource: source });

    await expect(
      repository.listActiveByGroup({ groupId: "chat-a", limit: 500 }),
    ).resolves.toEqual([expectedMemory()]);
    expect(source.query).toHaveBeenCalledWith(
      expect.stringMatching(/where gm\.group_id = \$1[\s\S]+gm\.status = 'active'/iu),
      ["chat-a", 100],
    );
  });

  it("fails closed when a persisted memory has no evidence", async () => {
    const source = dataSource(scriptedClient([]), [
      memoryRow({ evidence_message_ids: [] }),
    ]);
    const repository = createPostgresGroupMemoryRepository({ dataSource: source });

    await expect(
      repository.listActiveByGroup({ groupId: "chat-a", limit: 8 }),
    ).rejects.toThrow("memory evidence must not be empty");
  });

  it("corrects an active memory atomically and reuses its evidence", async () => {
    const replacementRow = memoryRow({
      id: "memory-2",
      content: "The launch is Friday.",
      idempotency_key: "correction-1",
      origin: "operator",
      created_by: "alice",
      supersedes_memory_id: "memory-1",
      importance: 5,
      confidence: 1,
      evidence_message_ids: ["feishu:msg-1", "feishu:msg-2", "feishu:msg-3"],
    });
    const client = scriptedClient([
      step(/begin/u),
      step(/select group_id[\s\S]+from group_memories[\s\S]+where id = \$1/u, [
        { group_id: "chat-a" },
      ]),
      step(/pg_advisory_xact_lock/u),
      step(/where gm\.id = \$1[\s\S]+for update/u, [memoryRow()]),
      step(/from group_memories[\s\S]+idempotency_key/u, []),
      step(/from conversation_messages/u, [
        { id: "feishu:msg-1", chat_id: "chat-a" },
        { id: "feishu:msg-2", chat_id: "chat-a" },
        { id: "feishu:msg-3", chat_id: "chat-a" },
      ]),
      step(/insert into group_memories/u, [replacementRow]),
      step(/insert into group_memory_message_evidence/u),
      step(/update group_memories[\s\S]+status = 'superseded'/u),
      step(/commit/u),
    ]);
    const repository = createPostgresGroupMemoryRepository({
      dataSource: dataSource(client),
    });

    const result = await repository.correct({
      memoryId: "memory-1",
      content: "The launch is Friday.",
      importance: 5,
      confidence: 1,
      idempotencyKey: "correction-1",
      origin: "operator",
      createdBy: "alice",
      evidenceMessageIds: ["feishu:msg-3"],
    });

    expect(result).toEqual({
      created: true,
      memory: expectedMemory({
        id: "memory-2",
        content: "The launch is Friday.",
        importance: 5,
        confidence: 1,
        idempotencyKey: "correction-1",
        origin: "operator",
        createdBy: "alice",
        supersedesMemoryId: "memory-1",
        evidenceMessageIds: ["feishu:msg-1", "feishu:msg-2", "feishu:msg-3"],
      }),
    });
  });

  it("rejects a correction idempotency key belonging to another operation", async () => {
    const client = scriptedClient([
      step(/begin/u),
      step(/select group_id[\s\S]+from group_memories[\s\S]+where id = \$1/u, [
        { group_id: "chat-a" },
      ]),
      step(/pg_advisory_xact_lock/u),
      step(/where gm\.id = \$1[\s\S]+for update/u, [memoryRow()]),
      step(/from group_memories[\s\S]+idempotency_key/u, [memoryRow()]),
      step(/rollback/u),
    ]);
    const repository = createPostgresGroupMemoryRepository({
      dataSource: dataSource(client),
    });

    await expect(repository.correct({
      memoryId: "memory-1",
      content: "The launch is Friday.",
      idempotencyKey: "extract:chat-a:topic-1",
      origin: "operator",
      createdBy: "alice",
    })).rejects.toBeInstanceOf(GroupMemoryIdempotencyConflictError);
  });

  it("rejects a correction replay whose normalized request fingerprint differs", async () => {
    const existingCorrection = memoryRow({
      id: "memory-2",
      idempotency_key: "correction-1",
      origin: "operator",
      created_by: "alice",
      supersedes_memory_id: "memory-1",
      request_fingerprint: "0".repeat(64),
    });
    const client = scriptedClient([
      step(/begin/u),
      step(/select group_id[\s\S]+from group_memories[\s\S]+where id = \$1/u, [
        { group_id: "chat-a" },
      ]),
      step(/pg_advisory_xact_lock/u),
      step(/where gm\.id = \$1[\s\S]+for update/u, [memoryRow()]),
      step(/from group_memories[\s\S]+idempotency_key/u, [existingCorrection]),
      step(/commit/u),
    ]);
    const repository = createPostgresGroupMemoryRepository({
      dataSource: dataSource(client),
    });

    await expect(repository.correct({
      memoryId: "memory-1",
      content: "The launch is Thursday.",
      idempotencyKey: "correction-1",
      origin: "operator",
      createdBy: "alice",
    })).rejects.toBeInstanceOf(GroupMemoryIdempotencyConflictError);
  });

  it("returns the existing correction for an exact normalized request replay", async () => {
    const correctionInput = {
      memoryId: "memory-1",
      content: "The launch is Thursday.",
      idempotencyKey: "correction-1",
      origin: "operator" as const,
      createdBy: "alice",
    };
    const existingCorrection = memoryRow({
      id: "memory-2",
      idempotency_key: correctionInput.idempotencyKey,
      origin: correctionInput.origin,
      created_by: correctionInput.createdBy,
      supersedes_memory_id: correctionInput.memoryId,
      request_fingerprint: correctionRequestFingerprint(correctionInput),
    });
    const client = scriptedClient([
      step(/begin/u),
      step(/select group_id[\s\S]+from group_memories[\s\S]+where id = \$1/u, [
        { group_id: "chat-a" },
      ]),
      step(/pg_advisory_xact_lock/u),
      step(/where gm\.id = \$1[\s\S]+for update/u, [memoryRow()]),
      step(/from group_memories[\s\S]+idempotency_key/u, [existingCorrection]),
      step(/commit/u),
    ]);
    const repository = createPostgresGroupMemoryRepository({
      dataSource: dataSource(client),
    });

    await expect(repository.correct(correctionInput)).resolves.toMatchObject({
      created: false,
      memory: { id: "memory-2", supersedesMemoryId: "memory-1" },
    });
  });

  it("rolls back a failed correction without superseding the original", async () => {
    const insertionError = new Error("insert failed");
    const client = scriptedClient([
      step(/begin/u),
      step(/select group_id[\s\S]+from group_memories[\s\S]+where id = \$1/u, [
        { group_id: "chat-a" },
      ]),
      step(/pg_advisory_xact_lock/u),
      step(/where gm\.id = \$1[\s\S]+for update/u, [memoryRow()]),
      step(/from group_memories[\s\S]+idempotency_key/u, []),
      step(/from conversation_messages/u, [
        { id: "feishu:msg-1", chat_id: "chat-a" },
        { id: "feishu:msg-2", chat_id: "chat-a" },
      ]),
      failingStep(/insert into group_memories/u, insertionError),
      step(/rollback/u),
    ]);
    const repository = createPostgresGroupMemoryRepository({
      dataSource: dataSource(client),
    });

    await expect(
      repository.correct({
        memoryId: "memory-1",
        content: "Corrected",
        idempotencyKey: "correction-1",
        origin: "operator",
        createdBy: "alice",
      }),
    ).rejects.toBe(insertionError);
    expect(normalizedCalls(client)).not.toEqual(
      expect.arrayContaining([expect.stringContaining("status = 'superseded'")]),
    );
  });

  it("hard deletes a memory and reports not-found deterministically", async () => {
    const client = scriptedClient([
      step(/begin/u),
      step(/select group_id[\s\S]+from group_memories[\s\S]+where id = \$1/u, [
        { group_id: "chat-a" },
      ]),
      step(/pg_advisory_xact_lock/u),
      step(/delete from group_memories[\s\S]+returning id/u, [{ id: "memory-1" }]),
      step(/commit/u),
      step(/begin/u),
      step(/select group_id[\s\S]+from group_memories[\s\S]+where id = \$1/u, []),
      step(/commit/u),
    ]);
    const source = dataSource(client);
    const repository = createPostgresGroupMemoryRepository({ dataSource: source });

    await expect(repository.deleteById("memory-1")).resolves.toBe("deleted");

    await expect(repository.deleteById("missing")).resolves.toBe("not_found");
    expect(client.query).toHaveBeenCalledWith(
      expect.stringMatching(/delete from group_memories[\s\S]+returning id/iu),
      ["memory-1", "chat-a"],
    );
  });
});

runIfDatabase("PostgresGroupMemoryRepository with Postgres", () => {
  let pool: pg.Pool | undefined;
  const suffix = randomUUID();
  const groupId = `memory-group-${suffix}`;
  const otherGroupId = `other-memory-group-${suffix}`;
  const messageId = `feishu:memory-message-${suffix}`;
  const otherMessageId = `feishu:other-memory-message-${suffix}`;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl });
    const client = await pool.connect();
    try {
      await runMigrations({ client, migrationsDir: defaultMigrationsDir() });
    } finally {
      client.release();
    }
    await pool.query(
      `
      INSERT INTO conversation_messages (
        id, provider, provider_message_id, chat_id, sender_id,
        message_type, text, sent_at, raw_event_idempotency_key
      )
      VALUES
        ($1, 'feishu', $2, $3, 'alice', 'text', 'Launch Thursday.', NOW(), $4),
        ($5, 'feishu', $6, $7, 'bob', 'text', 'Other group.', NOW(), $8)
      `,
      [
        messageId,
        `provider-${messageId}`,
        groupId,
        `event-${messageId}`,
        otherMessageId,
        `provider-${otherMessageId}`,
        otherGroupId,
        `event-${otherMessageId}`,
      ],
    );
  });

  afterAll(async () => {
    if (pool === undefined) {
      return;
    }
    try {
      await pool.query("DELETE FROM group_memories WHERE group_id = ANY($1::text[])", [
        [groupId, otherGroupId],
      ]);
      await pool.query("DELETE FROM conversation_messages WHERE id = ANY($1::text[])", [
        [messageId, otherMessageId],
      ]);
    } finally {
      await pool.end();
    }
  });

  it("serializes one group without blocking an independent group lock", async () => {
    const first = await pool!.connect();
    const second = await pool!.connect();
    try {
      await first.query("BEGIN");
      await second.query("BEGIN");
      await lockGroupMemoryWriteScope({ queryable: first, groupId });
      await second.query("SET LOCAL lock_timeout = '100ms'");

      await expect(
        lockGroupMemoryWriteScope({ queryable: second, groupId: otherGroupId }),
      ).resolves.toBeUndefined();
      await expect(
        lockGroupMemoryWriteScope({ queryable: second, groupId }),
      ).rejects.toMatchObject({ code: "55P03" });
    } finally {
      await first.query("ROLLBACK");
      await second.query("ROLLBACK");
      first.release();
      second.release();
    }
  });

  it("creates, isolates, corrects, and hard-deletes evidence-bound memory", async () => {
    if (pool === undefined) {
      throw new Error("Expected Postgres pool to be initialized");
    }
    const repository = createPostgresGroupMemoryRepository({ dataSource: pool });

    const createMemoryInput = {
      groupId,
      scope: "group" as const,
      category: "decision" as const,
      content: "Launch Thursday.",
      importance: 4,
      confidence: 0.9,
      idempotencyKey: `create-${suffix}`,
      origin: "operator" as const,
      createdBy: "alice",
      evidenceMessageIds: [messageId],
    };
    await expect(repository.create(createMemoryInput)).resolves.toMatchObject({
      created: true,
      memory: { groupId, status: "active" },
    });
    await expect(repository.create(createMemoryInput)).resolves.toMatchObject({
      created: false,
      memory: { groupId, status: "active" },
    });

    await expect(pool.query("DELETE FROM conversation_messages WHERE id = $1", [messageId]))
      .rejects.toMatchObject({ code: "23503" });

    await expect(repository.create({
      groupId,
      scope: "group",
      category: "decision",
      content: "Cross-group evidence must fail.",
      importance: 4,
      confidence: 0.9,
      idempotencyKey: `cross-group-${suffix}`,
      origin: "operator",
      createdBy: "alice",
      evidenceMessageIds: [otherMessageId],
    })).rejects.toThrow("memory evidence must belong to the same group");

    const [original] = await repository.listActiveByGroup({ groupId, limit: 8 });
    expect(original).toMatchObject({ content: "Launch Thursday.", status: "active" });
    const correctionInput = {
      memoryId: original!.id,
      content: "Launch Friday.",
      idempotencyKey: `correct-${suffix}`,
      origin: "operator",
      createdBy: "alice",
    } as const;
    const correction = await repository.correct(correctionInput);

    expect(correction).toMatchObject({
      created: true,
      memory: {
        groupId,
        content: "Launch Friday.",
        status: "active",
        supersedesMemoryId: original!.id,
        evidenceMessageIds: [messageId],
      },
    });
    await expect(repository.correct(correctionInput)).resolves.toMatchObject({
      created: false,
      memory: { id: correction.memory.id },
    });
    await expect(repository.correct({
      ...correctionInput,
      importance: original!.importance,
    })).rejects.toBeInstanceOf(GroupMemoryIdempotencyConflictError);
    await expect(repository.listActiveByGroup({ groupId, limit: 8 })).resolves.toEqual([
      expect.objectContaining({ id: correction.memory.id, content: "Launch Friday." }),
    ]);
    await expect(repository.getById(original!.id)).resolves.toMatchObject({
      status: "superseded",
    });
    await expect(repository.listActiveByGroup({ groupId: otherGroupId, limit: 8 })).resolves.toEqual([]);

    await expect(repository.deleteById(correction.memory.id)).resolves.toBe("deleted");
    await expect(repository.getById(correction.memory.id)).resolves.toBeUndefined();
  });

  it.each(["open", "resolved"] as const)(
    "fails closed through a stale repair before an exact v3 %s projection",
    async (finalStatus) => {
      const testSuffix = randomUUID();
      const testGroupId = `projection-visibility-group-${testSuffix}`;
      const testMessageId = `projection-visibility-message-${testSuffix}`;
      const threadId = `projection-visibility-thread-${testSuffix}`;
      const staleRepairId = `projection-visibility-stale-${testSuffix}`;
      const exactRepairId = `projection-visibility-exact-${testSuffix}`;
      const repository = createPostgresGroupMemoryRepository({ dataSource: pool! });
      const stateRepository = createPostgresConversationStateRepository({ dataSource: pool! });
      const projector = createConversationStateProjector({
        repository: stateRepository,
        memories: createGroupMemoryService({ repository }),
      });

      await pool!.query(
        `
        INSERT INTO conversation_messages (
          id, provider, provider_message_id, chat_id, sender_id,
          message_type, text, sent_at, raw_event_idempotency_key
        ) VALUES ($1, 'feishu', $2, $3, 'alice', 'text', 'Projection evidence.', NOW(), $4)
        `,
        [testMessageId, `provider-${testMessageId}`, testGroupId, `event-${testMessageId}`],
      );
      await pool!.query(
        `
        INSERT INTO discussion_threads (
          id, group_id, title, summary, status, confidence, version,
          first_evidence_at, last_activity_at
        ) VALUES ($1, $2, 'Projection visibility', 'Version one.', 'open', 0.9, 1, NOW(), NOW())
        `,
        [threadId, testGroupId],
      );
      await pool!.query(
        `
        INSERT INTO discussion_thread_evidence (thread_id, group_id, conversation_message_id)
        VALUES ($1, $2, $3)
        `,
        [threadId, testGroupId, testMessageId],
      );
      const v1 = await repository.create({
        groupId: testGroupId,
        scope: "thread",
        category: "summary",
        threadKey: threadId,
        content: "Version one.",
        importance: 1,
        confidence: 0.9,
        idempotencyKey: `projection:thread:${threadId}:1`,
        origin: "system",
        createdBy: "conversation-state-projector",
        evidenceMessageIds: [testMessageId],
      });
      await pool!.query(
        `
        INSERT INTO conversation_state_projection_repairs (
          id, entity_type, entity_id, group_id, entity_version, status,
          attempt_count, next_attempt_at
        ) VALUES ($1, 'thread', $2, $3, 1, 'completed', 1, NOW())
        `,
        [`projection-visibility-v1-${testSuffix}`, threadId, testGroupId],
      );
      await pool!.query(
        `
        INSERT INTO conversation_state_memory_projections (
          entity_type, entity_id, group_id, projected_version, memory_id
        ) VALUES ('thread', $1, $2, 1, $3)
        `,
        [threadId, testGroupId, v1.memory.id],
      );

      try {
        await expect(repository.listActiveByGroup({ groupId: testGroupId, limit: 8 }))
          .resolves.toEqual([expect.objectContaining({ id: v1.memory.id })]);

        await pool!.query(
          `UPDATE discussion_threads SET summary = 'Version two.', version = 2, updated_at = NOW() WHERE id = $1`,
          [threadId],
        );
        await pool!.query(
          `
          INSERT INTO conversation_state_projection_repairs (
            id, entity_type, entity_id, group_id, entity_version, status,
            attempt_count, next_attempt_at
          ) VALUES ($1, 'thread', $2, $3, 2, 'pending', 0, NOW())
          `,
          [staleRepairId, threadId, testGroupId],
        );
        await pool!.query(
          `
          UPDATE discussion_threads
          SET summary = 'Version three.', status = $2, version = 3,
              resolved_at = CASE WHEN $2 = 'resolved' THEN NOW() ELSE NULL END,
              updated_at = NOW()
          WHERE id = $1
          `,
          [threadId, finalStatus],
        );

        await projector.processBatch({ limit: 1, now: new Date(Date.now() + 60_000) });

        await expect(repository.listActiveByGroup({ groupId: testGroupId, limit: 8 }))
          .resolves.toEqual([]);
        await expect(pool!.query(
          `
          SELECT projected_version, memory_id
          FROM conversation_state_memory_projections
          WHERE entity_type = 'thread' AND entity_id = $1
          `,
          [threadId],
        )).resolves.toMatchObject({
          rows: [{ projected_version: "1", memory_id: v1.memory.id }],
        });

        await pool!.query(
          `
          INSERT INTO conversation_state_projection_repairs (
            id, entity_type, entity_id, group_id, entity_version, status,
            attempt_count, next_attempt_at
          ) VALUES ($1, 'thread', $2, $3, 3, 'pending', 0, NOW())
          `,
          [exactRepairId, threadId, testGroupId],
        );
        await projector.processBatch({ limit: 1, now: new Date(Date.now() + 60_000) });

        const active = await repository.listActiveByGroup({ groupId: testGroupId, limit: 8 });
        if (finalStatus === "open") {
          expect(active).toEqual([
            expect.objectContaining({ content: "Version three.", status: "active" }),
          ]);
          await expect(repository.getById(v1.memory.id)).resolves.toMatchObject({
            status: "superseded",
          });
        } else {
          expect(active).toEqual([]);
          await expect(repository.getById(v1.memory.id)).resolves.toBeUndefined();
        }
        await expect(pool!.query(
          `
          SELECT projected_version, memory_id
          FROM conversation_state_memory_projections
          WHERE entity_type = 'thread' AND entity_id = $1
          `,
          [threadId],
        )).resolves.toMatchObject({
          rows: [{
            projected_version: "3",
            memory_id: finalStatus === "open" ? active[0]!.id : null,
          }],
        });
      } finally {
        await pool!.query(
          "DELETE FROM conversation_state_projection_repairs WHERE entity_type = 'thread' AND entity_id = $1",
          [threadId],
        );
        await pool!.query(
          "DELETE FROM conversation_state_memory_projections WHERE entity_type = 'thread' AND entity_id = $1",
          [threadId],
        );
        await pool!.query("DELETE FROM group_memories WHERE group_id = $1", [testGroupId]);
        await pool!.query("DELETE FROM discussion_thread_evidence WHERE thread_id = $1", [threadId]);
        await pool!.query("DELETE FROM discussion_threads WHERE id = $1", [threadId]);
        await pool!.query("DELETE FROM conversation_messages WHERE id = $1", [testMessageId]);
      }
    },
  );

  it("keeps candidate- and merged-thread action projections out of answer memory", async () => {
    const testSuffix = randomUUID();
    const testGroupId = `action-dependency-visibility-${testSuffix}`;
    const testMessageId = `action-dependency-message-${testSuffix}`;
    const candidateThreadId = `action-candidate-thread-${testSuffix}`;
    const mergedThreadId = `action-merged-thread-${testSuffix}`;
    const targetThreadId = `action-target-thread-${testSuffix}`;
    const candidateActionId = `candidate-action-${testSuffix}`;
    const mergedActionId = `merged-action-${testSuffix}`;
    const repository = createPostgresGroupMemoryRepository({ dataSource: pool! });
    const provider = createGroupMemoryContextProvider({ repository });

    await pool!.query(
      `
      INSERT INTO conversation_messages (
        id, provider, provider_message_id, chat_id, sender_id,
        message_type, text, sent_at, raw_event_idempotency_key
      ) VALUES ($1, 'feishu', $2, $3, 'alice', 'text', 'Action dependency evidence.', NOW(), $4)
      `,
      [testMessageId, `provider-${testMessageId}`, testGroupId, `event-${testMessageId}`],
    );
    await pool!.query(
      `
      INSERT INTO discussion_threads (
        id, group_id, title, summary, status, confidence, merged_into_thread_id,
        version, first_evidence_at, last_activity_at
      ) VALUES
        ($1, $4, 'Candidate', 'Candidate summary', 'candidate', 0.9, NULL, 1, NOW(), NOW()),
        ($2, $4, 'Target', 'Target summary', 'open', 0.9, NULL, 1, NOW(), NOW()),
        ($3, $4, 'Merged', 'Merged summary', 'merged', 0.9, $2, 2, NOW(), NOW())
      `,
      [candidateThreadId, targetThreadId, mergedThreadId, testGroupId],
    );
    await pool!.query(
      `
      INSERT INTO action_items (
        id, group_id, thread_id, description, owner_ref_type, owner_ref,
        status, confidence, version
      ) VALUES
        ($1, $3, $4, 'Candidate action content', 'text_label', 'Alice', 'open', 0.9, 1),
        ($2, $3, $5, 'Merged action content', 'text_label', 'Alice', 'open', 0.9, 1)
      `,
      [candidateActionId, mergedActionId, testGroupId, candidateThreadId, mergedThreadId],
    );
    const candidateMemory = await repository.create({
      groupId: testGroupId,
      scope: "action",
      category: "action",
      threadKey: candidateThreadId,
      content: "Candidate action content",
      importance: 1,
      confidence: 0.9,
      idempotencyKey: `projection:action:${candidateActionId}:1`,
      origin: "system",
      createdBy: "conversation-state-projector",
      evidenceMessageIds: [testMessageId],
    });
    const mergedMemory = await repository.create({
      groupId: testGroupId,
      scope: "action",
      category: "action",
      threadKey: mergedThreadId,
      content: "Merged action content",
      importance: 1,
      confidence: 0.9,
      idempotencyKey: `projection:action:${mergedActionId}:1`,
      origin: "system",
      createdBy: "conversation-state-projector",
      evidenceMessageIds: [testMessageId],
    });
    await pool!.query(
      `
      INSERT INTO conversation_state_projection_repairs (
        id, entity_type, entity_id, group_id, entity_version, status,
        attempt_count, next_attempt_at
      ) VALUES
        ($1, 'action', $3, $5, 1, 'completed', 1, NOW()),
        ($2, 'action', $4, $5, 1, 'completed', 1, NOW())
      `,
      [
        `candidate-action-repair-${testSuffix}`,
        `merged-action-repair-${testSuffix}`,
        candidateActionId,
        mergedActionId,
        testGroupId,
      ],
    );
    await pool!.query(
      `
      INSERT INTO conversation_state_memory_projections (
        entity_type, entity_id, group_id, projected_version, memory_id
      ) VALUES
        ('action', $1, $3, 1, $4),
        ('action', $2, $3, 1, $5)
      `,
      [candidateActionId, mergedActionId, testGroupId, candidateMemory.memory.id, mergedMemory.memory.id],
    );

    await expect(provider.loadActiveMemories({ groupId: testGroupId, limit: 8 }))
      .resolves.toEqual([]);
  });

  it("round-trips an action memory thread key", async () => {
    const repository = createPostgresGroupMemoryRepository({ dataSource: pool! });
    const created = await repository.create({
      groupId,
      scope: "action",
      category: "action",
      threadKey: "thread-7",
      content: "Ship the repair projector.",
      importance: 4,
      confidence: 0.9,
      idempotencyKey: `action-thread-key-${suffix}`,
      origin: "system",
      createdBy: "conversation-state-projector",
      evidenceMessageIds: [messageId],
    });

    expect(created.memory).toMatchObject({
      scope: "action",
      threadKey: "thread-7",
    });
    await expect(repository.getById(created.memory.id)).resolves.toMatchObject({
      scope: "action",
      threadKey: "thread-7",
    });
    const corrected = await repository.correct({
      memoryId: created.memory.id,
      threadKey: "thread-8",
      content: "Ship the repair projector safely.",
      idempotencyKey: `action-thread-key-correction-${suffix}`,
      origin: "system",
      createdBy: "conversation-state-projector",
      evidenceMessageIds: [messageId],
    });
    expect(corrected.memory).toMatchObject({ scope: "action", threadKey: "thread-8" });
    await expect(repository.getById(corrected.memory.id)).resolves.toMatchObject({
      scope: "action",
      threadKey: "thread-8",
    });
  });
});

type ScriptStep = {
  pattern: RegExp;
  rows?: unknown[];
  error?: Error;
};

function step(pattern: RegExp, rows: unknown[] = []): ScriptStep {
  return { pattern, rows };
}

function failingStep(pattern: RegExp, error: Error): ScriptStep {
  return { pattern, error };
}

type MockTransactionClient = TransactionClient & {
  query: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
};

type MockDataSource = PostgresGroupMemoryDataSource & {
  connect: ReturnType<typeof vi.fn>;
  query: ReturnType<typeof vi.fn>;
};

function scriptedClient(steps: ScriptStep[]): MockTransactionClient {
  const queue = [...steps];
  return {
    query: vi.fn(async (sql: string) => {
      const next = queue.shift();
      if (next === undefined) {
        throw new Error(`unexpected query: ${normalizeSql(sql)}`);
      }
      expect(normalizeSql(sql)).toMatch(next.pattern);
      if (next.error !== undefined) {
        throw next.error;
      }
      return { rows: next.rows ?? [] };
    }),
    release: vi.fn(),
  } as unknown as MockTransactionClient;
}

function dataSource(
  client: Queryable & { release(): void },
  queryRows: unknown[] = [],
): MockDataSource {
  return {
    connect: vi.fn(async () => client),
    query: vi.fn(async () => ({ rows: queryRows })),
  } as unknown as MockDataSource;
}

function normalizedCalls(client: MockTransactionClient): string[] {
  return client.query.mock.calls.map(([sql]) => normalizeSql(String(sql)));
}

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/gu, " ").trim().toLowerCase();
}

function createInput() {
  return {
    groupId: "chat-a",
    scope: "group" as const,
    category: "decision" as const,
    content: "The launch is Thursday.",
    importance: 4,
    confidence: 0.9,
    idempotencyKey: "extract:chat-a:topic-1",
    origin: "extractor" as const,
    createdBy: "memory-worker",
    evidenceMessageIds: ["feishu:msg-1", "feishu:msg-2"],
  };
}

function memoryRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "memory-1",
    group_id: "chat-a",
    memory_scope: "group",
    category: "decision",
    thread_key: null,
    content: "The launch is Thursday.",
    importance: 4,
    confidence: 0.9,
    status: "active",
    idempotency_key: "extract:chat-a:topic-1",
    origin: "extractor",
    created_by: "memory-worker",
    supersedes_memory_id: null,
    request_fingerprint: createRequestFingerprint(createInput()),
    evidence_message_ids: ["feishu:msg-1", "feishu:msg-2"],
    created_at: new Date("2026-07-14T00:00:00.000Z"),
    updated_at: new Date("2026-07-14T00:00:00.000Z"),
    ...overrides,
  };
}

function createRequestFingerprint(input: ReturnType<typeof createInput>): string {
  return hashRequest({
    version: 1,
    operation: "create",
    groupId: input.groupId,
    scope: input.scope,
    category: input.category,
    threadKey: null,
    content: input.content,
    importance: input.importance,
    confidence: input.confidence,
    idempotencyKey: input.idempotencyKey,
    origin: input.origin,
    createdBy: input.createdBy,
    evidenceMessageIds: [...new Set(input.evidenceMessageIds)].sort(),
  });
}

function correctionRequestFingerprint(input: {
  memoryId: string;
  content: string;
  importance?: number;
  confidence?: number;
  idempotencyKey: string;
  origin: "extractor" | "operator" | "system";
  createdBy: string;
  evidenceMessageIds?: string[];
}): string {
  return hashRequest({
    version: 1,
    operation: "correct",
    memoryId: input.memoryId,
    content: input.content,
    importance: input.importance ?? null,
    confidence: input.confidence ?? null,
    idempotencyKey: input.idempotencyKey,
    origin: input.origin,
    createdBy: input.createdBy,
    evidenceMessageIds: input.evidenceMessageIds === undefined
      ? null
      : [...new Set(input.evidenceMessageIds)].sort(),
  });
}

function hashRequest(value: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function expectedMemory(overrides: Record<string, unknown> = {}) {
  return {
    id: "memory-1",
    groupId: "chat-a",
    scope: "group",
    category: "decision",
    content: "The launch is Thursday.",
    importance: 4,
    confidence: 0.9,
    status: "active",
    idempotencyKey: "extract:chat-a:topic-1",
    origin: "extractor",
    createdBy: "memory-worker",
    evidenceMessageIds: ["feishu:msg-1", "feishu:msg-2"],
    createdAt: new Date("2026-07-14T00:00:00.000Z"),
    updatedAt: new Date("2026-07-14T00:00:00.000Z"),
    ...overrides,
  };
}
