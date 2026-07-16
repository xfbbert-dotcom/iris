import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  ConversationStateVersionConflictError,
  createPostgresConversationStateRepository,
  type PostgresConversationStateDataSource,
  type TransactionClient,
} from "../src/conversation-state/postgres-conversation-state-repository.js";
import type {
  CreateConversationStateOperation,
  MutationConversationStateOperation,
} from "../src/conversation-state/conversation-state-repository.js";
import { defaultMigrationsDir, runMigrations } from "../src/database/migrate.js";

const databaseUrl = process.env.IRIS_TEST_DATABASE_URL?.trim() ?? process.env.TEST_DATABASE_URL?.trim();
const runIfDatabase = databaseUrl ? describe : describe.skip;
const postgresSuffix = randomUUID();
const postgresGroupId = `state-group-${postgresSuffix}`;
const postgresOtherGroupId = `state-other-group-${postgresSuffix}`;
const postgresMessageId = `feishu:state-message-${postgresSuffix}`;
const postgresSecondMessageId = `feishu:state-message-2-${postgresSuffix}`;
const postgresOtherMessageId = `feishu:state-other-message-${postgresSuffix}`;

describe("createPostgresConversationStateRepository", () => {
  it("rejects a thread event which references a different thread before connecting", async () => {
    const source = dataSource(scriptedClient([]));
    const repository = createPostgresConversationStateRepository({ dataSource: source });
    const operation = createThreadOperation();
    operation.threadEvent.threadId = "thread-2";

    await expect(repository.applyOperations({ groupId: "chat-a", operations: [operation] }))
      .rejects.toThrow("thread event must reference operation thread");
    expect(source.connect).not.toHaveBeenCalled();
  });

  it("rejects an action event which references a different action before connecting", async () => {
    const source = dataSource(scriptedClient([]));
    const repository = createPostgresConversationStateRepository({ dataSource: source });
    const operation = createActionOperation();
    operation.actionEvent.actionItemId = "action-2";

    await expect(repository.applyOperations({ groupId: "chat-a", operations: [operation] }))
      .rejects.toThrow("action event must reference operation action");
    expect(source.connect).not.toHaveBeenCalled();
  });

  it("rejects creation of an already merged thread before connecting", async () => {
    const source = dataSource(scriptedClient([]));
    const repository = createPostgresConversationStateRepository({ dataSource: source });
    const operation = createThreadOperation() as unknown as CreateConversationStateOperation;
    operation.thread!.status = "merged";
    operation.thread!.mergedIntoThreadId = "thread-2";

    await expect(repository.applyOperations({ groupId: "chat-a", operations: [operation] }))
      .rejects.toThrow("new discussion thread must not be merged");
    expect(source.connect).not.toHaveBeenCalled();
  });

  it("writes same-group evidence, one event, and one repair in one transaction", async () => {
    const client = scriptedClient([
      step(/begin/u),
      step(/from discussion_threads[\s\S]+for update/u, []),
      step(/from action_items[\s\S]+for update/u, []),
      step(/from discussion_thread_events[\s\S]+operation_key/u, [], ["chat-a", ["thread-create-1"]]),
      step(/from action_item_events[\s\S]+operation_key/u, [], ["chat-a", ["thread-create-1"]]),
      step(/from conversation_messages[\s\S]+chat_id = \$2/u, [{ id: "message-1" }], [["message-1"], "chat-a"]),
      step(/insert into discussion_threads/u),
      step(/insert into discussion_thread_evidence/u),
      step(/insert into discussion_thread_events/u),
      step(/insert into discussion_thread_event_evidence/u),
      step(/insert into conversation_state_projection_repairs/u),
      step(/commit/u),
    ]);
    const repository = createPostgresConversationStateRepository({ dataSource: dataSource(client) });

    await expect(repository.applyOperations({
      groupId: "chat-a",
      operations: [createThreadOperation()],
    })).resolves.toEqual({ status: "applied", threadIds: ["thread-1"], actionItemIds: [] });
    expect(client.release).toHaveBeenCalledOnce();
    expect(client.query).toHaveBeenCalledWith(
      expect.stringMatching(/pg_advisory_xact_lock/iu),
      ["conversation-state:chat-a"],
    );
  });

  it("rejects cross-group evidence and rolls back before writing state", async () => {
    const client = scriptedClient([
      step(/begin/u),
      step(/from discussion_threads[\s\S]+for update/u, []),
      step(/from action_items[\s\S]+for update/u, []),
      step(/from discussion_thread_events[\s\S]+operation_key/u, []),
      step(/from action_item_events[\s\S]+operation_key/u, []),
      step(/from conversation_messages[\s\S]+chat_id = \$2/u, []),
      step(/rollback/u),
    ]);
    const repository = createPostgresConversationStateRepository({ dataSource: dataSource(client) });

    await expect(repository.applyOperations({
      groupId: "chat-a",
      operations: [createThreadOperation()],
    })).rejects.toThrow("evidence must belong to the same group");
    expect(calls(client)).not.toEqual(expect.arrayContaining([
      expect.stringContaining("insert into discussion_threads"),
    ]));
  });

  it("returns already_applied only for an exact same-type replay", async () => {
    const client = scriptedClient([
      step(/begin/u),
      step(/from discussion_threads[\s\S]+for update/u, [threadRow()]),
      step(/from action_items[\s\S]+for update/u, []),
      step(/from discussion_thread_events[\s\S]+operation_key/u, [threadEventRow()], ["chat-a", ["thread-create-1"]]),
      step(/from action_item_events[\s\S]+operation_key/u, [], ["chat-a", ["thread-create-1"]]),
      step(/commit/u),
    ]);
    const repository = createPostgresConversationStateRepository({ dataSource: dataSource(client) });

    await expect(repository.applyOperations({
      groupId: "chat-a",
      operations: [createThreadOperation()],
    })).resolves.toEqual({ status: "already_applied", threadIds: [], actionItemIds: [] });
  });

  it("rejects a partially replayed batch", async () => {
    const threadOperation = createThreadOperation();
    const actionOperation = createActionOperation();
    const client = scriptedClient([
      step(/begin/u),
      step(/from discussion_threads[\s\S]+for update/u, [threadRow()]),
      step(/from action_items[\s\S]+for update/u, []),
      step(/from discussion_thread_events[\s\S]+operation_key/u, [threadEventRow()], ["chat-a", ["thread-create-1", "action-create-1"]]),
      step(/from action_item_events[\s\S]+operation_key/u, [], ["chat-a", ["thread-create-1", "action-create-1"]]),
      step(/rollback/u),
    ]);
    const repository = createPostgresConversationStateRepository({ dataSource: dataSource(client) });

    await expect(repository.applyOperations({
      groupId: "chat-a",
      operations: [threadOperation, actionOperation],
    })).rejects.toThrow("conversation state operation key conflict");
  });

  it("rejects an operation key already used by the other event type", async () => {
    const client = scriptedClient([
      step(/begin/u),
      step(/from discussion_threads[\s\S]+for update/u, []),
      step(/from action_items[\s\S]+for update/u, []),
      step(/from discussion_thread_events[\s\S]+operation_key/u, []),
      step(/from action_item_events[\s\S]+operation_key/u, [actionEventRow({ operation_key: "thread-create-1" })]),
      step(/rollback/u),
    ]);
    const repository = createPostgresConversationStateRepository({ dataSource: dataSource(client) });

    await expect(repository.applyOperations({
      groupId: "chat-a",
      operations: [createThreadOperation()],
    })).rejects.toThrow("conversation state operation key conflict");
  });

  it("rejects an operation key replayed with a different event payload", async () => {
    const client = scriptedClient([
      step(/begin/u),
      step(/from discussion_threads[\s\S]+for update/u, [threadRow()]),
      step(/from action_items[\s\S]+for update/u, []),
      step(/from discussion_thread_events[\s\S]+operation_key/u, [threadEventRow({ id: "different-event" })]),
      step(/from action_item_events[\s\S]+operation_key/u, []),
      step(/rollback/u),
    ]);
    const repository = createPostgresConversationStateRepository({ dataSource: dataSource(client) });

    await expect(repository.applyOperations({
      groupId: "chat-a",
      operations: [createThreadOperation()],
    })).rejects.toThrow("conversation state operation key conflict");
  });

  it("rejects a state operation without its audit event", async () => {
    const source = dataSource(scriptedClient([]));
    const repository = createPostgresConversationStateRepository({ dataSource: source });
    const operation = { ...createThreadOperation(), threadEvent: undefined };

    await expect(repository.applyOperations({ groupId: "chat-a", operations: [operation as never] }))
      .rejects.toThrow("operation must contain exactly one entity and matching event");
    expect(source.connect).not.toHaveBeenCalled();
  });

  it("rejects a stale mutation version before appending an event", async () => {
    const client = scriptedClient([
      step(/begin/u),
      step(/from discussion_threads[\s\S]+for update/u, [threadRow({ version: "3" })]),
      step(/from action_items[\s\S]+for update/u, []),
      step(/from discussion_thread_events[\s\S]+operation_key/u, []),
      step(/from action_item_events[\s\S]+operation_key/u, []),
      step(/rollback/u),
    ]);
    const repository = createPostgresConversationStateRepository({ dataSource: dataSource(client) });

    await expect(repository.applyOperations({
      groupId: "chat-a",
      operations: [resolveThreadOperation()],
    })).rejects.toBeInstanceOf(ConversationStateVersionConflictError);
  });

  it("applies a version-matched mutation exactly once", async () => {
    const client = scriptedClient([
      step(/begin/u),
      step(/from discussion_threads[\s\S]+for update/u, [threadRow({ version: "1" })]),
      step(/from action_items[\s\S]+for update/u, []),
      step(/from discussion_thread_events[\s\S]+operation_key/u, []),
      step(/from action_item_events[\s\S]+operation_key/u, []),
      step(/from conversation_messages[\s\S]+chat_id = \$2/u, [{ id: "message-1" }]),
      step(/update discussion_threads/u, [{ id: "thread-1" }]),
      step(/insert into discussion_thread_evidence/u),
      step(/insert into discussion_thread_events/u),
      step(/insert into discussion_thread_event_evidence/u),
      step(/insert into conversation_state_projection_repairs/u),
      step(/commit/u),
    ]);
    const repository = createPostgresConversationStateRepository({ dataSource: dataSource(client) });
    const operation = resolveThreadOperation();
    operation.expectedVersion = 1;
    operation.thread.version = 2;
    operation.threadEvent.fromVersion = 1;
    operation.threadEvent.toVersion = 2;

    await expect(repository.applyOperations({ groupId: "chat-a", operations: [operation] })).resolves.toEqual({
      status: "applied", threadIds: ["thread-1"], actionItemIds: [],
    });
  });

  it("rejects a merge cycle atomically", async () => {
    const client = scriptedClient([
      step(/begin/u),
      step(/from discussion_threads[\s\S]+for update/u, [
        threadRow({ id: "thread-1", status: "open", version: "1" }),
        threadRow({ id: "thread-2", status: "merged", version: "2", merged_into_thread_id: "thread-1" }),
      ]),
      step(/from action_items[\s\S]+for update/u, []),
      step(/from discussion_thread_events[\s\S]+operation_key/u, []),
      step(/from action_item_events[\s\S]+operation_key/u, []),
      step(/rollback/u),
    ]);
    const repository = createPostgresConversationStateRepository({ dataSource: dataSource(client) });

    await expect(repository.applyOperations({
      groupId: "chat-a",
      operations: [mergeThreadOperation()],
    })).rejects.toThrow("merge chain contains a cycle");
  });

  it("locks the group and accepts the terminal canonical merge target", async () => {
    const client = scriptedClient([
      step(/begin/u),
      step(/from discussion_threads thread[\s\S]+where thread\.group_id = \$1[\s\S]+for update/u, [
        threadRow({ id: "thread-1", status: "candidate", version: "1" }),
        threadRow({ id: "thread-2", status: "merged", version: "2", merged_into_thread_id: "thread-3" }),
        threadRow({ id: "thread-3", status: "open", version: "1" }),
      ]),
      step(/from action_items[\s\S]+for update/u, []),
      step(/from discussion_thread_events[\s\S]+operation_key/u, []),
      step(/from action_item_events[\s\S]+operation_key/u, []),
      step(/from conversation_messages[\s\S]+chat_id = \$2/u, [{ id: "message-1" }]),
      step(/update discussion_threads/u, [{ id: "thread-1" }]),
      step(/insert into discussion_thread_evidence/u),
      step(/insert into discussion_thread_events/u),
      step(/insert into discussion_thread_event_evidence/u),
      step(/insert into conversation_state_projection_repairs/u),
      step(/commit/u),
    ]);
    const repository = createPostgresConversationStateRepository({ dataSource: dataSource(client) });
    const operation = mergeThreadOperation();
    operation.thread.mergedIntoThreadId = "thread-3";

    await expect(repository.applyOperations({ groupId: "chat-a", operations: [operation] }))
      .resolves.toMatchObject({ status: "applied" });
    const updateCall = client.query.mock.calls.find(([sql]) => /update discussion_threads/iu.test(String(sql)));
    expect(updateCall?.[1]?.[6]).toBe("thread-3");
  });

  it("rejects a requested merge target when the source is canonical", async () => {
    const client = scriptedClient([
      step(/begin/u),
      step(/from discussion_threads[\s\S]+for update/u, [
        threadRow({ id: "thread-1", status: "open", evidence_count: "5" }),
        threadRow({ id: "thread-2", status: "candidate", evidence_count: "1" }),
      ]),
      step(/from action_items[\s\S]+for update/u, []),
      step(/from discussion_thread_events[\s\S]+operation_key/u, []),
      step(/from action_item_events[\s\S]+operation_key/u, []),
      step(/rollback/u),
    ]);
    const repository = createPostgresConversationStateRepository({ dataSource: dataSource(client) });

    await expect(repository.applyOperations({ groupId: "chat-a", operations: [mergeThreadOperation()] }))
      .rejects.toThrow("merge target is not canonical");
  });

  it("rolls back an entire batch when an accepted operation fails", async () => {
    const insertionError = new Error("insert failed");
    const client = scriptedClient([
      step(/begin/u),
      step(/from discussion_threads[\s\S]+for update/u, []),
      step(/from action_items[\s\S]+for update/u, []),
      step(/from discussion_thread_events[\s\S]+operation_key/u, []),
      step(/from action_item_events[\s\S]+operation_key/u, []),
      step(/from conversation_messages[\s\S]+chat_id = \$2/u, [{ id: "message-1" }]),
      failingStep(/insert into discussion_threads/u, insertionError),
      step(/rollback/u),
    ]);
    const repository = createPostgresConversationStateRepository({ dataSource: dataSource(client) });

    await expect(repository.applyOperations({
      groupId: "chat-a",
      operations: [createThreadOperation()],
    })).rejects.toBe(insertionError);
  });

  it("maps PostgreSQL BIGINT state columns returned as strings", async () => {
    const source = {
      connect: vi.fn(),
      query: vi.fn(async (sql: string) => ({
        rows: /from action_items/iu.test(sql)
            ? [actionRow()]
            : /from discussion_threads/iu.test(sql)
              ? [threadRow()]
              : [repairRow()],
      })),
    } as unknown as PostgresConversationStateDataSource;
    const repository = createPostgresConversationStateRepository({ dataSource: source });

    await expect(repository.listRelevantThreads({ groupId: "chat-a", limit: 1 }))
      .resolves.toMatchObject([{ version: 1 }]);
    await expect(repository.listRelevantActions({ groupId: "chat-a", limit: 1 }))
      .resolves.toMatchObject([{ version: 1 }]);
    await expect(repository.claimProjectionRepairs({ limit: 1, now: new Date("2026-07-16T00:00:00.000Z") }))
      .resolves.toMatchObject([{ entityVersion: 2 }]);
  });

  it("validates relevant thread statuses before querying", async () => {
    const source = dataSource(scriptedClient([]));
    const repository = createPostgresConversationStateRepository({ dataSource: source });

    await expect(repository.listRelevantThreads({
      groupId: "chat-a",
      limit: 1,
      statuses: ["invalid" as never],
    })).rejects.toThrow("thread status is invalid");
    expect(source.query).not.toHaveBeenCalled();
  });

  it("excludes candidate-linked actions only from answer-relevant reads", async () => {
    const source = {
      connect: vi.fn(),
      query: vi.fn(async () => ({ rows: [] })),
    } as unknown as PostgresConversationStateDataSource;
    const repository = createPostgresConversationStateRepository({ dataSource: source });

    await repository.listRelevantActions({ groupId: "chat-a", limit: 3 });
    expect(source.query).toHaveBeenLastCalledWith(
      expect.stringMatching(/not exists[\s\S]+discussion_threads[\s\S]+status = 'candidate'/iu),
      ["chat-a", null, null, 3],
    );

    await repository.loadExtractionContext({ groupId: "chat-a", threadLimit: 2, actionLimit: 3 });
    expect(source.query).toHaveBeenCalledWith(
      expect.stringMatching(/from discussion_threads/iu),
      ["chat-a", ["candidate", "open", "resolved"], 2],
    );
    expect(source.query).toHaveBeenCalledWith(
      expect.not.stringMatching(/not exists[\s\S]+status = 'candidate'/iu),
      ["chat-a", ["open"], null, 3],
    );
  });

  it("claims due failed repairs below the bounded attempt limit", async () => {
    const now = new Date("2026-07-16T00:00:00.000Z");
    const source = {
      connect: vi.fn(),
      query: vi.fn(async () => ({ rows: [] })),
    } as unknown as PostgresConversationStateDataSource;
    const repository = createPostgresConversationStateRepository({ dataSource: source });

    await repository.claimProjectionRepairs({ limit: 4, now });

    expect(source.query).toHaveBeenCalledWith(
      expect.stringMatching(/status in \('pending', 'failed'\)[\s\S]+next_attempt_at <= \$1[\s\S]+attempt_count < \$3/iu),
      [now, 4, 5],
    );
  });

  it("keeps projection versions monotonic when an older repair completes", async () => {
    const client = scriptedClient([
      step(/begin/u),
      step(/update conversation_state_projection_repairs/u, [repairRow()]),
      step(/insert into conversation_state_memory_projections[\s\S]+do update[\s\S]+where[\s\S]+projected_version < excluded\.projected_version/u),
      step(/commit/u),
    ]);
    const repository = createPostgresConversationStateRepository({ dataSource: dataSource(client) });

    await expect(repository.completeProjectionRepair({ id: "repair-1" })).resolves.toBeUndefined();
  });
});

runIfDatabase("PostgresConversationStateRepository with Postgres", () => {
  let pool: pg.Pool | undefined;
  const suffix = postgresSuffix;
  const groupId = postgresGroupId;
  const otherGroupId = postgresOtherGroupId;
  const messageId = postgresMessageId;
  const secondMessageId = postgresSecondMessageId;
  const otherMessageId = postgresOtherMessageId;

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
      ) VALUES
        ($1, 'feishu', $2, $3, 'alice', 'text', 'State evidence.', NOW(), $4),
        ($5, 'feishu', $6, $3, 'alice', 'text', 'More state evidence.', NOW(), $7),
        ($8, 'feishu', $9, $10, 'bob', 'text', 'Other state evidence.', NOW(), $11)
      `,
      [
        messageId, `provider-${messageId}`, groupId, `event-${messageId}`,
        secondMessageId, `provider-${secondMessageId}`, `event-${secondMessageId}`,
        otherMessageId, `provider-${otherMessageId}`, otherGroupId, `event-${otherMessageId}`,
      ],
    );
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("enforces evidence, replay, versions, merge chains, cycles, and batch rollback", async () => {
    const repository = createPostgresConversationStateRepository({ dataSource: pool! });
    const candidate = integrationThreadOperation({
      id: `candidate-${suffix}`,
      status: "candidate",
      eventType: "created",
      operationKey: `candidate-create-${suffix}`,
    });
    await expect(repository.applyOperations({ groupId, operations: [candidate] })).resolves.toMatchObject({
      status: "applied", threadIds: [candidate.thread!.id],
    });
    await expect(repository.applyOperations({ groupId, operations: [candidate] })).resolves.toEqual({
      status: "already_applied", threadIds: [], actionItemIds: [],
    });
    await expect(repository.applyOperations({
      groupId,
      operations: [integrationThreadOperation({
        id: candidate.thread!.id,
        status: "open",
        eventType: "promoted",
        operationKey: `candidate-promote-${suffix}`,
        expectedVersion: 1,
      })],
    })).resolves.toMatchObject({ status: "applied" });
    await expect(repository.applyOperations({
      groupId,
      operations: [integrationThreadOperation({
        id: candidate.thread!.id,
        status: "resolved",
        eventType: "resolved",
        operationKey: `candidate-stale-${suffix}`,
        expectedVersion: 1,
      })],
    })).rejects.toBeInstanceOf(ConversationStateVersionConflictError);
    await expect(repository.applyOperations({
      groupId,
      operations: [integrationThreadOperation({
        id: `cross-group-${suffix}`,
        status: "open",
        eventType: "created",
        operationKey: `cross-group-${suffix}`,
        evidenceMessageIds: [otherMessageId],
      })],
    })).rejects.toThrow("evidence must belong to the same group");

    const root = integrationThreadOperation({
      id: `root-${suffix}`, status: "open", eventType: "created", operationKey: `root-create-${suffix}`,
    });
    const leaf = integrationThreadOperation({
      id: `leaf-${suffix}`, status: "candidate", eventType: "created", operationKey: `leaf-create-${suffix}`,
    });
    await repository.applyOperations({ groupId, operations: [root, leaf] });
    await repository.applyOperations({
      groupId,
      operations: [integrationThreadOperation({
        id: leaf.thread!.id, status: "merged", eventType: "merged", operationKey: `leaf-merge-${suffix}`,
        expectedVersion: 1, mergedIntoThreadId: root.thread!.id,
      })],
    });
    const chained = integrationThreadOperation({
      id: `chained-${suffix}`, status: "candidate", eventType: "created", operationKey: `chained-create-${suffix}`,
    });
    await repository.applyOperations({ groupId, operations: [chained] });
    await expect(repository.applyOperations({
      groupId,
      operations: [integrationThreadOperation({
        id: chained.thread!.id, status: "merged", eventType: "merged", operationKey: `chained-merge-${suffix}`,
        expectedVersion: 1, mergedIntoThreadId: leaf.thread!.id,
      })],
    })).rejects.toThrow("merge target is not canonical");
    await repository.applyOperations({
      groupId,
      operations: [integrationThreadOperation({
        id: chained.thread!.id, status: "merged", eventType: "merged", operationKey: `chained-merge-root-${suffix}`,
        expectedVersion: 1, mergedIntoThreadId: root.thread!.id,
      })],
    });
    await expect(pool!.query(
      "SELECT merged_into_thread_id FROM discussion_threads WHERE id = $1",
      [chained.thread!.id],
    )).resolves.toMatchObject({ rows: [{ merged_into_thread_id: root.thread!.id }] });
    await expect(repository.applyOperations({
      groupId,
      operations: [integrationThreadOperation({
        id: root.thread!.id, status: "merged", eventType: "merged", operationKey: `root-cycle-${suffix}`,
        expectedVersion: 1, mergedIntoThreadId: leaf.thread!.id,
      })],
    })).rejects.toThrow("merge chain contains a cycle");

    const rollbackOne = integrationThreadOperation({
      id: `rollback-one-${suffix}`, status: "open", eventType: "created", operationKey: `rollback-one-${suffix}`,
      eventId: `rollback-event-${suffix}`,
    });
    const rollbackTwo = integrationThreadOperation({
      id: `rollback-two-${suffix}`, status: "open", eventType: "created", operationKey: `rollback-two-${suffix}`,
      eventId: `rollback-event-${suffix}`,
    });
    await expect(repository.applyOperations({ groupId, operations: [rollbackOne, rollbackTwo] })).rejects.toMatchObject({ code: "23505" });
    await expect(pool!.query("SELECT id FROM discussion_threads WHERE id = $1", [rollbackOne.thread!.id]))
      .resolves.toMatchObject({ rows: [] });
  });

  it("writes actions and rejects mismatched, partial, and cross-type operation replays", async () => {
    const repository = createPostgresConversationStateRepository({ dataSource: pool! });
    const action = integrationActionOperation({
      id: `action-${suffix}`,
      operationKey: `action-create-${suffix}`,
    });

    await expect(repository.applyOperations({ groupId, operations: [action] })).resolves.toMatchObject({
      status: "applied", actionItemIds: [action.action!.id],
    });
    await expect(repository.applyOperations({ groupId, operations: [action] })).resolves.toEqual({
      status: "already_applied", threadIds: [], actionItemIds: [],
    });
    await expect(pool!.query(
      `
      SELECT action.id, event.id AS event_id, evidence.conversation_message_id, repair.entity_version
      FROM action_items action
      JOIN action_item_events event ON event.action_item_id = action.id AND event.group_id = action.group_id
      JOIN action_item_event_evidence evidence ON evidence.event_id = event.id AND evidence.group_id = event.group_id
      JOIN conversation_state_projection_repairs repair
        ON repair.entity_type = 'action' AND repair.entity_id = action.id AND repair.group_id = action.group_id
      WHERE action.id = $1
      `,
      [action.action!.id],
    )).resolves.toMatchObject({
      rows: [{ id: action.action!.id, event_id: action.actionEvent!.id, conversation_message_id: messageId, entity_version: "1" }],
    });

    const mismatchedAction = integrationActionOperation({
      id: `mismatched-action-${suffix}`,
      operationKey: `mismatched-action-${suffix}`,
    });
    mismatchedAction.actionEvent!.actionItemId = `other-action-${suffix}`;
    await expect(repository.applyOperations({ groupId, operations: [mismatchedAction] }))
      .rejects.toThrow("action event must reference operation action");

    const mismatchedThread = integrationThreadOperation({
      id: `mismatched-thread-${suffix}`,
      status: "open",
      eventType: "created",
      operationKey: `mismatched-thread-${suffix}`,
    });
    mismatchedThread.threadEvent!.threadId = `other-thread-${suffix}`;
    await expect(repository.applyOperations({ groupId, operations: [mismatchedThread] }))
      .rejects.toThrow("thread event must reference operation thread");

    const partialThread = integrationThreadOperation({
      id: `partial-thread-${suffix}`,
      status: "open",
      eventType: "created",
      operationKey: `partial-thread-${suffix}`,
    });
    await expect(repository.applyOperations({ groupId, operations: [action, partialThread] }))
      .rejects.toThrow("conversation state operation key conflict");
    await expect(pool!.query("SELECT id FROM discussion_threads WHERE id = $1", [partialThread.thread!.id]))
      .resolves.toMatchObject({ rows: [] });

    const crossType = integrationThreadOperation({
      id: `cross-type-${suffix}`,
      status: "open",
      eventType: "created",
      operationKey: action.operationKey,
    });
    await expect(repository.applyOperations({ groupId, operations: [crossType] }))
      .rejects.toThrow("conversation state operation key conflict");
  });

  it("uses persisted evidence counts to enforce the canonical merge direction", async () => {
    const repository = createPostgresConversationStateRepository({ dataSource: pool! });
    const richTarget = integrationThreadOperation({
      id: `rich-target-${suffix}`, status: "open", eventType: "created", operationKey: `rich-target-${suffix}`,
      evidenceMessageIds: [messageId, secondMessageId],
    });
    const poorSource = integrationThreadOperation({
      id: `poor-source-${suffix}`, status: "open", eventType: "created", operationKey: `poor-source-${suffix}`,
    });
    const richSource = integrationThreadOperation({
      id: `rich-source-${suffix}`, status: "open", eventType: "created", operationKey: `rich-source-${suffix}`,
      evidenceMessageIds: [messageId, secondMessageId],
    });
    const poorTarget = integrationThreadOperation({
      id: `poor-target-${suffix}`, status: "open", eventType: "created", operationKey: `poor-target-${suffix}`,
    });
    await repository.applyOperations({ groupId, operations: [richTarget, poorSource, richSource, poorTarget] });

    await expect(repository.applyOperations({
      groupId,
      operations: [integrationThreadOperation({
        id: poorSource.thread!.id, status: "merged", eventType: "merged", operationKey: `poor-merge-${suffix}`,
        expectedVersion: 1, mergedIntoThreadId: richTarget.thread!.id,
      })],
    })).resolves.toMatchObject({ status: "applied" });
    await expect(repository.applyOperations({
      groupId,
      operations: [integrationThreadOperation({
        id: richSource.thread!.id, status: "merged", eventType: "merged", operationKey: `rich-merge-${suffix}`,
        expectedVersion: 1, mergedIntoThreadId: poorTarget.thread!.id,
      })],
    })).rejects.toThrow("merge target is not canonical");
  });

  it("hides candidate-linked actions from relevant reads but keeps them in extraction context", async () => {
    const repository = createPostgresConversationStateRepository({ dataSource: pool! });
    const candidate = integrationThreadOperation({
      id: `hidden-candidate-${suffix}`, status: "candidate", eventType: "created", operationKey: `hidden-candidate-${suffix}`,
    });
    const action = integrationActionOperation({
      id: `hidden-action-${suffix}`, operationKey: `hidden-action-${suffix}`, threadId: candidate.thread!.id,
    });
    await repository.applyOperations({ groupId, operations: [candidate, action] });

    const relevant = await repository.listRelevantActions({ groupId, limit: 100 });
    expect(relevant.map((item) => item.id)).not.toContain(action.action!.id);
    const extraction = await repository.loadExtractionContext({ groupId, threadLimit: 100, actionLimit: 100 });
    expect(extraction.threads.map((thread) => thread.id)).toContain(candidate.thread!.id);
    expect(extraction.actions.map((item) => item.id)).toContain(action.action!.id);
  });

  it("retries due failed repairs, stops at the attempt limit, and completes projections monotonically", async () => {
    const repository = createPostgresConversationStateRepository({ dataSource: pool! });
    const retryRepairId = `retry-repair-${suffix}`;
    await pool!.query(
      `
      INSERT INTO conversation_state_projection_repairs (
        id, entity_type, entity_id, group_id, entity_version, status,
        attempt_count, next_attempt_at, created_at, updated_at
      ) VALUES ($1, 'thread', $2, $3, 1, 'pending', 0, $4, $5, $5)
      `,
      [retryRepairId, `retry-entity-${suffix}`, groupId, new Date("2100-01-01T00:00:00.000Z"), new Date("1900-01-01T00:00:00.000Z")],
    );

    const beforeDue = await repository.claimProjectionRepairs({ limit: 100, now: new Date("2099-12-31T00:00:00.000Z") });
    expect(beforeDue.map((repair) => repair.id)).not.toContain(retryRepairId);
    const firstClaim = await repository.claimProjectionRepairs({ limit: 100, now: new Date("2100-01-01T00:00:00.000Z") });
    expect(firstClaim).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: retryRepairId, status: "processing", attemptCount: 1 }),
    ]));
    await repository.failProjectionRepair({
      id: retryRepairId,
      retryAt: new Date("2101-01-01T00:00:00.000Z"),
      classification: "transient",
    });
    const beforeRetry = await repository.claimProjectionRepairs({ limit: 100, now: new Date("2100-06-01T00:00:00.000Z") });
    expect(beforeRetry.map((repair) => repair.id)).not.toContain(retryRepairId);
    const secondClaim = await repository.claimProjectionRepairs({ limit: 100, now: new Date("2101-01-01T00:00:00.000Z") });
    expect(secondClaim).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: retryRepairId, status: "processing", attemptCount: 2 }),
    ]));
    await pool!.query(
      "UPDATE conversation_state_projection_repairs SET status = 'failed', attempt_count = 5, next_attempt_at = $2 WHERE id = $1",
      [retryRepairId, new Date("2101-01-01T00:00:00.000Z")],
    );
    const exhausted = await repository.claimProjectionRepairs({ limit: 100, now: new Date("2200-01-01T00:00:00.000Z") });
    expect(exhausted.map((repair) => repair.id)).not.toContain(retryRepairId);

    const projectionEntityId = `projection-entity-${suffix}`;
    const oldRepairId = `projection-old-${suffix}`;
    const newRepairId = `projection-new-${suffix}`;
    await pool!.query(
      `
      INSERT INTO conversation_state_projection_repairs (
        id, entity_type, entity_id, group_id, entity_version, status,
        attempt_count, next_attempt_at, created_at, updated_at
      ) VALUES
        ($1, 'thread', $3, $4, 1, 'processing', 1, NOW(), NOW(), NOW()),
        ($2, 'thread', $3, $4, 2, 'processing', 1, NOW(), NOW(), NOW())
      `,
      [oldRepairId, newRepairId, projectionEntityId, groupId],
    );
    await repository.completeProjectionRepair({ id: newRepairId });
    await repository.completeProjectionRepair({ id: oldRepairId });
    await expect(pool!.query(
      "SELECT projected_version FROM conversation_state_memory_projections WHERE entity_type = 'thread' AND entity_id = $1",
      [projectionEntityId],
    )).resolves.toMatchObject({ rows: [{ projected_version: "2" }] });
  });
});

type ScriptStep = { pattern: RegExp; rows?: unknown[]; error?: Error; values?: unknown[] };

function step(pattern: RegExp, rows: unknown[] = [], values?: unknown[]): ScriptStep {
  return { pattern, rows, values };
}

function failingStep(pattern: RegExp, error: Error): ScriptStep {
  return { pattern, error };
}

type MockClient = TransactionClient & {
  query: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
};

function scriptedClient(steps: ScriptStep[]): MockClient {
  const queue = [...steps];
  return {
    query: vi.fn(async (sql: string, values?: unknown[]) => {
      if (/pg_advisory_xact_lock/iu.test(sql)) {
        expect(values).toEqual(["conversation-state:chat-a"]);
        return { rows: [] };
      }
      const next = queue.shift();
      if (next === undefined) throw new Error(`unexpected query: ${normalize(sql)}`);
      expect(normalize(sql)).toMatch(next.pattern);
      if (next.values !== undefined) expect(values).toEqual(next.values);
      if (next.error !== undefined) throw next.error;
      return { rows: next.rows ?? [] };
    }),
    release: vi.fn(),
  } as unknown as MockClient;
}

function dataSource(client: MockClient): PostgresConversationStateDataSource {
  return { connect: vi.fn(async () => client), query: vi.fn(async () => ({ rows: [] })) };
}

function calls(client: MockClient): string[] {
  return client.query.mock.calls.map(([sql]) => normalize(String(sql)));
}

function normalize(sql: string): string {
  return sql.replace(/\s+/gu, " ").trim().toLowerCase();
}

function createThreadOperation() {
  const now = new Date("2026-07-16T00:00:00.000Z");
  return {
    kind: "create" as const,
    operationKey: "thread-create-1",
    thread: {
      id: "thread-1", groupId: "chat-a", title: "Launch", summary: "Launch scope",
      status: "open" as const, confidence: 0.8, version: 1,
      firstEvidenceAt: now, lastActivityAt: now, createdAt: now, updatedAt: now,
    },
    threadEvent: {
      id: "thread-event-1", threadId: "thread-1", groupId: "chat-a", eventType: "created" as const,
      toVersion: 1, operationKey: "thread-create-1", createdAt: now,
    },
    evidenceMessageIds: ["message-1"],
  };
}

function createActionOperation() {
  const now = new Date("2026-07-16T00:00:00.000Z");
  return {
    kind: "create" as const,
    operationKey: "action-create-1",
    action: {
      id: "action-1", groupId: "chat-a", description: "Follow up", ownerRefType: "feishu_user" as const,
      ownerRef: "alice", status: "open" as const, confidence: 0.8, version: 1,
      createdAt: now, updatedAt: now,
    },
    actionEvent: {
      id: "action-event-1", actionItemId: "action-1", groupId: "chat-a", eventType: "created" as const,
      toVersion: 1, operationKey: "action-create-1", createdAt: now,
    },
    evidenceMessageIds: ["message-1"],
  };
}

function resolveThreadOperation() {
  const now = new Date("2026-07-16T00:00:00.000Z");
  return {
    kind: "mutation" as const,
    operationKey: "thread-resolve-1", expectedVersion: 2,
    thread: {
      id: "thread-1", groupId: "chat-a", title: "Launch", summary: "Launch scope",
      status: "resolved" as const, confidence: 0.8, version: 3,
      firstEvidenceAt: now, lastActivityAt: now, resolvedAt: now, createdAt: now, updatedAt: now,
    },
    threadEvent: {
      id: "thread-event-2", threadId: "thread-1", groupId: "chat-a", eventType: "resolved" as const,
      fromVersion: 2, toVersion: 3, operationKey: "thread-resolve-1", createdAt: now,
    },
    evidenceMessageIds: ["message-1"],
  };
}

function mergeThreadOperation() {
  const now = new Date("2026-07-16T00:00:00.000Z");
  return {
    kind: "mutation" as const,
    operationKey: "thread-merge-1", expectedVersion: 1,
    thread: {
      id: "thread-1", groupId: "chat-a", title: "Launch", summary: "Launch scope",
      status: "merged" as const, confidence: 0.8, mergedIntoThreadId: "thread-2", version: 2,
      firstEvidenceAt: now, lastActivityAt: now, createdAt: now, updatedAt: now,
    },
    threadEvent: {
      id: "thread-event-3", threadId: "thread-1", groupId: "chat-a", eventType: "merged" as const,
      fromVersion: 1, toVersion: 2, operationKey: "thread-merge-1", createdAt: now,
    },
    evidenceMessageIds: ["message-1"],
  };
}

function threadRow(overrides: Record<string, unknown> = {}) {
  const now = new Date("2026-07-16T00:00:00.000Z");
  return {
    id: "thread-1", group_id: "chat-a", title: "Launch", summary: "Launch scope",
    status: "open", confidence: 0.8, merged_into_thread_id: null, version: "1",
    first_evidence_at: now, last_activity_at: now, resolved_at: null, created_at: now, updated_at: now,
    evidence_count: "0",
    ...overrides,
  };
}

function actionRow(overrides: Record<string, unknown> = {}) {
  const now = new Date("2026-07-16T00:00:00.000Z");
  return {
    id: "action-1", group_id: "chat-a", thread_id: null, description: "Follow up.",
    owner_ref_type: "feishu_user", owner_ref: "alice", due_at: null, status: "open",
    confidence: 0.8, version: "1", completed_at: null, cancelled_at: null,
    created_at: now, updated_at: now,
    ...overrides,
  };
}

function repairRow(overrides: Record<string, unknown> = {}) {
  const now = new Date("2026-07-16T00:00:00.000Z");
  return {
    id: "repair-1", entity_type: "thread", entity_id: "thread-1", group_id: "chat-a",
    entity_version: "2", status: "processing", attempt_count: 1, next_attempt_at: now,
    failure_classification: null, created_at: now, updated_at: now,
    ...overrides,
  };
}

function threadEventRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "thread-event-1", thread_id: "thread-1", group_id: "chat-a", event_type: "created",
    from_version: null, to_version: "1", operation_key: "thread-create-1",
    created_at: new Date("2026-07-16T00:00:00.000Z"), evidence_message_ids: ["message-1"],
    ...overrides,
  };
}

function actionEventRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "action-event-1", action_item_id: "action-1", group_id: "chat-a", event_type: "created",
    from_version: null, to_version: "1", operation_key: "action-create-1",
    created_at: new Date("2026-07-16T00:00:00.000Z"), evidence_message_ids: ["message-1"],
    ...overrides,
  };
}

type IntegrationThreadOperationInput = {
  id: string;
  status: "candidate" | "open" | "resolved" | "merged";
  eventType: "created" | "promoted" | "resolved" | "merged";
  operationKey: string;
  mergedIntoThreadId?: string;
  evidenceMessageIds?: string[];
  eventId?: string;
};

function integrationThreadOperation(
  input: IntegrationThreadOperationInput & { expectedVersion: number },
): MutationConversationStateOperation;
function integrationThreadOperation(
  input: IntegrationThreadOperationInput & { expectedVersion?: undefined },
): CreateConversationStateOperation;
function integrationThreadOperation(
  input: IntegrationThreadOperationInput & { expectedVersion?: number },
): CreateConversationStateOperation | MutationConversationStateOperation {
  const now = new Date("2026-07-16T00:00:00.000Z");
  const mutation = input.expectedVersion !== undefined;
  const version = mutation ? input.expectedVersion! + 1 : 1;
  const thread = {
    id: input.id, groupId: postgresGroupId, title: `Thread ${input.id}`, summary: "Semantic state test.", status: input.status,
    confidence: 0.8, version, firstEvidenceAt: now, lastActivityAt: now, createdAt: now, updatedAt: now,
    ...(input.status === "resolved" ? { resolvedAt: now } : {}),
    ...(input.status === "merged" ? { mergedIntoThreadId: input.mergedIntoThreadId } : {}),
  };
  const event = {
    id: input.eventId ?? `event-${input.operationKey}`, threadId: input.id, groupId: postgresGroupId,
    eventType: input.eventType, toVersion: version, operationKey: input.operationKey, createdAt: now,
  };
  if (mutation) {
    return {
      kind: "mutation", operationKey: input.operationKey, expectedVersion: input.expectedVersion!, thread,
      threadEvent: { ...event, fromVersion: input.expectedVersion! },
      evidenceMessageIds: input.evidenceMessageIds ?? [postgresMessageId],
    } as MutationConversationStateOperation;
  }
  return {
    kind: "create", operationKey: input.operationKey, thread, threadEvent: event,
    evidenceMessageIds: input.evidenceMessageIds ?? [postgresMessageId],
  } as CreateConversationStateOperation;
}

function integrationActionOperation(input: {
  id: string;
  operationKey: string;
  threadId?: string;
  evidenceMessageIds?: string[];
}): CreateConversationStateOperation {
  const now = new Date("2026-07-16T00:00:00.000Z");
  return {
    kind: "create",
    operationKey: input.operationKey,
    action: {
      id: input.id,
      groupId: postgresGroupId,
      ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
      description: `Action ${input.id}`,
      ownerRefType: "feishu_user",
      ownerRef: "alice",
      status: "open",
      confidence: 0.8,
      version: 1,
      createdAt: now,
      updatedAt: now,
    },
    actionEvent: {
      id: `event-${input.operationKey}`,
      actionItemId: input.id,
      groupId: postgresGroupId,
      eventType: "created",
      toVersion: 1,
      operationKey: input.operationKey,
      createdAt: now,
    },
    evidenceMessageIds: input.evidenceMessageIds ?? [postgresMessageId],
  };
}
