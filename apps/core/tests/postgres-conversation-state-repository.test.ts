import { createHash, randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  ConversationStateIdempotencyConflictError,
  ConversationStateVersionConflictError,
  createPostgresConversationStateRepository,
  type PostgresConversationStateDataSource,
  type TransactionClient,
} from "../src/conversation-state/postgres-conversation-state-repository.js";
import type {
  ConversationStateOperation,
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
    const operation = createThreadOperation();
    const client = scriptedClient([
      step(/begin/u),
      step(/from conversation_state_operation_claims/u, [], ["chat-a", ["thread-create-1"]]),
      step(/from discussion_threads[\s\S]+for update/u, []),
      step(/from action_items[\s\S]+for update/u, []),
      step(/from conversation_messages[\s\S]+chat_id = \$2/u, [{ id: "message-1" }], [["message-1"], "chat-a"]),
      step(/insert into discussion_threads/u),
      step(/insert into discussion_thread_evidence/u),
      step(/insert into discussion_thread_events/u),
      step(/insert into discussion_thread_event_evidence/u),
      step(/insert into conversation_state_projection_repairs/u),
      step(/insert into conversation_state_operation_claims/u, [], [
        "chat-a", "thread-create-1", "thread", "thread-1", operationFingerprint(operation),
      ]),
      step(/commit/u),
    ]);
    const repository = createPostgresConversationStateRepository({ dataSource: dataSource(client) });

    await expect(repository.applyOperations({
      groupId: "chat-a",
      operations: [operation],
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
      step(/from conversation_state_operation_claims/u, []),
      step(/from discussion_threads[\s\S]+for update/u, []),
      step(/from action_items[\s\S]+for update/u, []),
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

  it.each(["candidate", "open"] as const)("records an evidence_attached audit event for a %s thread", async (status) => {
    const operation = attachEvidenceThreadOperation(status);
    const client = scriptedClient([
      step(/begin/u),
      step(/from conversation_state_operation_claims/u, []),
      step(/from discussion_threads[\s\S]+for update/u, [threadRow({ status, version: "1" })]),
      step(/from action_items[\s\S]+for update/u, []),
      step(/from conversation_messages[\s\S]+chat_id = \$2/u, [{ id: "message-1" }]),
      step(/update discussion_threads/u, [{ id: "thread-1" }]),
      step(/insert into discussion_thread_evidence/u),
      step(/insert into discussion_thread_events/u),
      step(/insert into discussion_thread_event_evidence/u),
      ...(status === "open" ? [step(/insert into conversation_state_projection_repairs/u)] : []),
      step(/insert into conversation_state_operation_claims/u),
      step(/commit/u),
    ]);
    const repository = createPostgresConversationStateRepository({ dataSource: dataSource(client) });

    await expect(repository.applyOperations({ groupId: "chat-a", operations: [operation] }))
      .resolves.toEqual({ status: "applied", threadIds: ["thread-1"], actionItemIds: [] });
    const eventCall = client.query.mock.calls.find(([sql]) => /insert into discussion_thread_events/iu.test(String(sql)));
    expect(eventCall?.[1]?.[3]).toBe("evidence_attached");
  });

  it("replays a historical create claim without reading the upgraded entity snapshot", async () => {
    const operation = createThreadOperation();
    const client = scriptedClient([
      step(/begin/u),
      step(
        /from conversation_state_operation_claims[\s\S]+operation_key/u,
        [operationClaimRow(operation)],
        ["chat-a", ["thread-create-1"]],
      ),
      step(/commit/u),
    ]);
    const repository = createPostgresConversationStateRepository({ dataSource: dataSource(client) });

    await expect(repository.applyOperations({
      groupId: "chat-a",
      operations: [operation],
    })).resolves.toEqual({ status: "already_applied", threadIds: [], actionItemIds: [] });
    expect(calls(client)).not.toEqual(expect.arrayContaining([
      expect.stringMatching(/from discussion_threads|from action_items/u),
    ]));
  });

  it("uses sorted unique evidence ids in the operation fingerprint", async () => {
    const persisted = createThreadOperation();
    persisted.evidenceMessageIds = ["message-1", "message-2"];
    const replay = createThreadOperation();
    replay.evidenceMessageIds = ["message-2", "message-1", "message-2"];
    const client = scriptedClient([
      step(/begin/u),
      step(
        /from conversation_state_operation_claims[\s\S]+operation_key/u,
        [operationClaimRow(persisted)],
        ["chat-a", ["thread-create-1"]],
      ),
      step(/commit/u),
    ]);
    const repository = createPostgresConversationStateRepository({ dataSource: dataSource(client) });

    await expect(repository.applyOperations({ groupId: "chat-a", operations: [replay] }))
      .resolves.toEqual({ status: "already_applied", threadIds: [], actionItemIds: [] });
  });

  it("replays a complete batch containing consecutive versions of one entity", async () => {
    const create = createThreadOperation();
    const resolve = resolveThreadOperation();
    resolve.expectedVersion = 1;
    resolve.thread.version = 2;
    resolve.threadEvent.fromVersion = 1;
    resolve.threadEvent.toVersion = 2;
    const client = scriptedClient([
      step(/begin/u),
      step(
        /from conversation_state_operation_claims[\s\S]+operation_key/u,
        [operationClaimRow(create), operationClaimRow(resolve)],
        ["chat-a", ["thread-create-1", "thread-resolve-1"]],
      ),
      step(/commit/u),
    ]);
    const repository = createPostgresConversationStateRepository({ dataSource: dataSource(client) });

    await expect(repository.applyOperations({ groupId: "chat-a", operations: [create, resolve] }))
      .resolves.toEqual({ status: "already_applied", threadIds: [], actionItemIds: [] });
  });

  it("rejects a partially replayed batch", async () => {
    const threadOperation = createThreadOperation();
    const actionOperation = createActionOperation();
    const client = scriptedClient([
      step(/begin/u),
      step(/from conversation_state_operation_claims/u, [operationClaimRow(threadOperation)], [
        "chat-a", ["thread-create-1", "action-create-1"],
      ]),
      step(/rollback/u),
    ]);
    const repository = createPostgresConversationStateRepository({ dataSource: dataSource(client) });

    await expect(repository.applyOperations({
      groupId: "chat-a",
      operations: [threadOperation, actionOperation],
    })).rejects.toThrow("conversation state operation key conflict");
  });

  it("rejects an operation key already used by the other event type", async () => {
    const operation = createThreadOperation();
    const client = scriptedClient([
      step(/begin/u),
      step(/from conversation_state_operation_claims/u, [operationClaimRow(operation, {
        entity_type: "action",
        entity_id: "action-1",
      })]),
      step(/rollback/u),
    ]);
    const repository = createPostgresConversationStateRepository({ dataSource: dataSource(client) });

    await expect(repository.applyOperations({
      groupId: "chat-a",
      operations: [operation],
    })).rejects.toThrow("conversation state operation key conflict");
  });

  it("rejects an operation key replayed with a different event payload", async () => {
    const operation = createThreadOperation();
    const client = scriptedClient([
      step(/begin/u),
      step(/from conversation_state_operation_claims/u, [operationClaimRow(operation, {
        operation_fingerprint: "f".repeat(64),
      })]),
      step(/rollback/u),
    ]);
    const repository = createPostgresConversationStateRepository({ dataSource: dataSource(client) });

    await expect(repository.applyOperations({
      groupId: "chat-a",
      operations: [operation],
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
      step(/from conversation_state_operation_claims/u, []),
      step(/from discussion_threads[\s\S]+for update/u, [threadRow({ version: "3" })]),
      step(/from action_items[\s\S]+for update/u, []),
      step(/rollback/u),
    ]);
    const repository = createPostgresConversationStateRepository({ dataSource: dataSource(client) });

    await expect(repository.applyOperations({
      groupId: "chat-a",
      operations: [resolveThreadOperation()],
    })).rejects.toBeInstanceOf(ConversationStateVersionConflictError);
  });

  it("applies a version-matched mutation exactly once", async () => {
    const operation = resolveThreadOperation();
    operation.expectedVersion = 1;
    operation.thread.version = 2;
    operation.threadEvent.fromVersion = 1;
    operation.threadEvent.toVersion = 2;
    const client = scriptedClient([
      step(/begin/u),
      step(/from conversation_state_operation_claims/u, []),
      step(/from discussion_threads[\s\S]+for update/u, [threadRow({ version: "1" })]),
      step(/from action_items[\s\S]+for update/u, []),
      step(/from conversation_messages[\s\S]+chat_id = \$2/u, [{ id: "message-1" }]),
      step(/update discussion_threads/u, [{ id: "thread-1" }]),
      step(/insert into discussion_thread_evidence/u),
      step(/insert into discussion_thread_events/u),
      step(/insert into discussion_thread_event_evidence/u),
      step(/insert into conversation_state_projection_repairs/u),
      step(/insert into conversation_state_operation_claims/u, [], [
        "chat-a", "thread-resolve-1", "thread", "thread-1", operationFingerprint(operation),
      ]),
      step(/commit/u),
    ]);
    const repository = createPostgresConversationStateRepository({ dataSource: dataSource(client) });

    await expect(repository.applyOperations({ groupId: "chat-a", operations: [operation] })).resolves.toEqual({
      status: "applied", threadIds: ["thread-1"], actionItemIds: [],
    });
  });

  it("rejects a merge cycle atomically", async () => {
    const client = scriptedClient([
      step(/begin/u),
      step(/from conversation_state_operation_claims/u, []),
      step(/from discussion_threads[\s\S]+for update/u, [
        threadRow({ id: "thread-1", status: "open", version: "1" }),
        threadRow({ id: "thread-2", status: "merged", version: "2", merged_into_thread_id: "thread-1" }),
      ]),
      step(/from action_items[\s\S]+for update/u, []),
      step(/rollback/u),
    ]);
    const repository = createPostgresConversationStateRepository({ dataSource: dataSource(client) });

    await expect(repository.applyOperations({
      groupId: "chat-a",
      operations: [mergeThreadOperation()],
    })).rejects.toThrow("merge chain contains a cycle");
  });

  it("locks the group and accepts the terminal canonical merge target", async () => {
    const operation = mergeThreadOperation();
    const client = scriptedClient([
      step(/begin/u),
      step(/from conversation_state_operation_claims/u, []),
      step(/from discussion_threads thread[\s\S]+where thread\.group_id = \$1[\s\S]+for update/u, [
        threadRow({ id: "thread-1", status: "candidate", version: "1" }),
        threadRow({ id: "thread-2", status: "merged", version: "2", merged_into_thread_id: "thread-3" }),
        threadRow({ id: "thread-3", status: "open", version: "1" }),
      ]),
      step(/from action_items[\s\S]+for update/u, []),
      step(/from conversation_messages[\s\S]+chat_id = \$2/u, [{ id: "message-1" }]),
      step(/update discussion_threads/u, [{ id: "thread-1" }]),
      step(/insert into discussion_thread_evidence/u),
      step(/insert into discussion_thread_events/u),
      step(/insert into discussion_thread_event_evidence/u),
      step(/insert into conversation_state_projection_repairs/u),
      step(/insert into conversation_state_operation_claims/u, [], [
        "chat-a", "thread-merge-1", "thread", "thread-1", operationFingerprint(operation),
      ]),
      step(/commit/u),
    ]);
    const repository = createPostgresConversationStateRepository({ dataSource: dataSource(client) });

    await expect(repository.applyOperations({ groupId: "chat-a", operations: [operation] }))
      .resolves.toMatchObject({ status: "applied" });
    const updateCall = client.query.mock.calls.find(([sql]) => /update discussion_threads/iu.test(String(sql)));
    expect(updateCall?.[1]?.[6]).toBe("thread-3");
  });

  it("rejects a requested merge target when the source is canonical", async () => {
    const client = scriptedClient([
      step(/begin/u),
      step(/from conversation_state_operation_claims/u, []),
      step(/from discussion_threads[\s\S]+for update/u, [
        threadRow({ id: "thread-1", status: "open", evidence_count: "5" }),
        threadRow({ id: "thread-2", status: "candidate", evidence_count: "1" }),
      ]),
      step(/from action_items[\s\S]+for update/u, []),
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
      step(/from conversation_state_operation_claims/u, []),
      step(/from discussion_threads[\s\S]+for update/u, []),
      step(/from action_items[\s\S]+for update/u, []),
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
    await expect(repository.applyOperations({ groupId, operations: [candidate] })).resolves.toEqual({
      status: "already_applied", threadIds: [], actionItemIds: [],
    });
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
    })).resolves.toMatchObject({ status: "applied" });
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

  it("replays a complete same-entity batch after consecutive versions were committed", async () => {
    const repository = createPostgresConversationStateRepository({ dataSource: pool! });
    const create = integrationThreadOperation({
      id: `batch-thread-${suffix}`,
      status: "candidate",
      eventType: "created",
      operationKey: `batch-create-${suffix}`,
    });
    const promote = integrationThreadOperation({
      id: create.thread!.id,
      status: "open",
      eventType: "promoted",
      operationKey: `batch-promote-${suffix}`,
      expectedVersion: 1,
    });

    await expect(repository.applyOperations({ groupId, operations: [create, promote] }))
      .resolves.toMatchObject({ status: "applied", threadIds: [create.thread!.id, create.thread!.id] });
    await expect(repository.applyOperations({ groupId, operations: [create, promote] })).resolves.toEqual({
      status: "already_applied", threadIds: [], actionItemIds: [],
    });
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

  it("serializes concurrent identical operations across independent pool clients", async () => {
    const operation = integrationThreadOperation({
      id: `concurrent-same-${suffix}`,
      status: "open",
      eventType: "created",
      operationKey: `concurrent-same-${suffix}`,
    });
    const firstClient = await pool!.connect();
    const secondClient = await pool!.connect();
    const firstRepository = createPostgresConversationStateRepository({
      dataSource: connectedClientDataSource(firstClient),
    });
    const secondRepository = createPostgresConversationStateRepository({
      dataSource: connectedClientDataSource(secondClient),
    });

    const results = await Promise.all([
      firstRepository.applyOperations({ groupId, operations: [operation] }),
      secondRepository.applyOperations({ groupId, operations: [operation] }),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual(["already_applied", "applied"]);
    await expect(pool!.query(
      `
      SELECT
        (SELECT COUNT(*)::int FROM discussion_threads WHERE id = $1) AS entity_count,
        (SELECT COUNT(*)::int FROM discussion_thread_events WHERE operation_key = $2 AND group_id = $3) AS event_count,
        (SELECT COUNT(*)::int FROM conversation_state_projection_repairs WHERE entity_type = 'thread' AND entity_id = $1) AS repair_count,
        (SELECT COUNT(*)::int FROM conversation_state_operation_claims WHERE operation_key = $2 AND group_id = $3) AS claim_count
      `,
      [operation.thread!.id, operation.operationKey, groupId],
    )).resolves.toMatchObject({
      rows: [{ entity_count: 1, event_count: 1, repair_count: 1, claim_count: 1 }],
    });
  });

  it("allows exactly one concurrent payload for the same operation key", async () => {
    const operationKey = `concurrent-conflict-${suffix}`;
    const firstOperation = integrationThreadOperation({
      id: `concurrent-conflict-a-${suffix}`,
      status: "open",
      eventType: "created",
      operationKey,
    });
    const secondOperation = integrationThreadOperation({
      id: `concurrent-conflict-b-${suffix}`,
      status: "open",
      eventType: "created",
      operationKey,
    });
    const firstClient = await pool!.connect();
    const secondClient = await pool!.connect();
    const firstRepository = createPostgresConversationStateRepository({
      dataSource: connectedClientDataSource(firstClient),
    });
    const secondRepository = createPostgresConversationStateRepository({
      dataSource: connectedClientDataSource(secondClient),
    });

    const results = await Promise.allSettled([
      firstRepository.applyOperations({ groupId, operations: [firstOperation] }),
      secondRepository.applyOperations({ groupId, operations: [secondOperation] }),
    ]);
    const applied = results.find((result) => result.status === "fulfilled");
    const conflicted = results.find((result) => result.status === "rejected");

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(applied?.status === "fulfilled" ? applied.value.status : undefined).toBe("applied");
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(conflicted?.status === "rejected" ? conflicted.reason : undefined)
      .toBeInstanceOf(ConversationStateIdempotencyConflictError);
    await expect(pool!.query(
      `
      SELECT
        (SELECT COUNT(*)::int FROM discussion_threads WHERE id = ANY($1::text[])) AS entity_count,
        (SELECT COUNT(*)::int FROM discussion_thread_events WHERE operation_key = $2 AND group_id = $3) AS event_count,
        (SELECT COUNT(*)::int FROM conversation_state_projection_repairs WHERE entity_type = 'thread' AND entity_id = ANY($1::text[])) AS repair_count,
        (SELECT COUNT(*)::int FROM conversation_state_operation_claims WHERE operation_key = $2 AND group_id = $3) AS claim_count
      `,
      [[firstOperation.thread!.id, secondOperation.thread!.id], operationKey, groupId],
    )).resolves.toMatchObject({
      rows: [{ entity_count: 1, event_count: 1, repair_count: 1, claim_count: 1 }],
    });
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

function connectedClientDataSource(client: pg.PoolClient): PostgresConversationStateDataSource {
  return {
    connect: async () => client,
    query: async (sql: string, values?: unknown[]) => client.query(sql, values),
  } as unknown as PostgresConversationStateDataSource;
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

function attachEvidenceThreadOperation(status: "candidate" | "open") {
  const now = new Date("2026-07-16T00:00:00.000Z");
  return {
    kind: "mutation" as const,
    operationKey: `thread-attach-${status}`,
    expectedVersion: 1,
    thread: {
      id: "thread-1", groupId: "chat-a", title: "Launch", summary: "Launch scope",
      status, confidence: 0.8, version: 2,
      firstEvidenceAt: now, lastActivityAt: now, createdAt: now, updatedAt: now,
    },
    threadEvent: {
      id: `thread-event-attach-${status}`, threadId: "thread-1", groupId: "chat-a",
      eventType: "evidence_attached" as never, fromVersion: 1, toVersion: 2,
      operationKey: `thread-attach-${status}`, createdAt: now,
    },
    evidenceMessageIds: ["message-1"],
  } as MutationConversationStateOperation;
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

function operationClaimRow(
  operation: ConversationStateOperation,
  overrides: Record<string, unknown> = {},
) {
  const entityType = operation.thread === undefined ? "action" : "thread";
  const entityId = operation.thread?.id ?? operation.action!.id;
  return {
    group_id: "chat-a",
    operation_key: operation.operationKey,
    entity_type: entityType,
    entity_id: entityId,
    operation_fingerprint: operationFingerprint(operation),
    created_at: new Date("2026-07-16T00:00:00.000Z"),
    ...overrides,
  };
}

function operationFingerprint(operation: ConversationStateOperation): string {
  const payload = {
    ...operation,
    evidenceMessageIds: [...new Set(operation.evidenceMessageIds)].sort(),
  };
  return createHash("sha256").update(JSON.stringify(orderFingerprintValue(payload))).digest("hex");
}

function orderFingerprintValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(orderFingerprintValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, item]) => [key, orderFingerprintValue(item)]),
    );
  }
  return value;
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
