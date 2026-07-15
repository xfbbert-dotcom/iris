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
const postgresOtherMessageId = `feishu:state-other-message-${postgresSuffix}`;

describe("createPostgresConversationStateRepository", () => {
  it("writes same-group evidence, one event, and one repair in one transaction", async () => {
    const client = scriptedClient([
      step(/begin/u),
      step(/from discussion_threads[\s\S]+for update/u, []),
      step(/from action_items[\s\S]+for update/u, []),
      step(/from discussion_thread_events[\s\S]+operation_key/u, []),
      step(/from action_item_events[\s\S]+operation_key/u, []),
      step(/from conversation_messages[\s\S]+chat_id = \$2/u, [{ id: "message-1" }]),
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

  it("returns already_applied when every operation key has already been appended", async () => {
    const client = scriptedClient([
      step(/begin/u),
      step(/from discussion_threads[\s\S]+for update/u, []),
      step(/from action_items[\s\S]+for update/u, []),
      step(/from discussion_thread_events[\s\S]+operation_key/u, [{ operation_key: "thread-create-1" }]),
      step(/from action_item_events[\s\S]+operation_key/u, []),
      step(/commit/u),
    ]);
    const repository = createPostgresConversationStateRepository({ dataSource: dataSource(client) });

    await expect(repository.applyOperations({
      groupId: "chat-a",
      operations: [createThreadOperation()],
    })).resolves.toEqual({ status: "already_applied", threadIds: [], actionItemIds: [] });
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

  it("locks the group and resolves a merge chain to its terminal target", async () => {
    const client = scriptedClient([
      step(/begin/u),
      step(/from discussion_threads[\s\S]+where group_id = \$1 for update/u, [
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

    await expect(repository.applyOperations({ groupId: "chat-a", operations: [mergeThreadOperation()] }))
      .resolves.toMatchObject({ status: "applied" });
    const updateCall = client.query.mock.calls.find(([sql]) => /update discussion_threads/iu.test(String(sql)));
    expect(updateCall?.[1]?.[6]).toBe("thread-3");
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
        rows: /from discussion_threads/iu.test(sql)
          ? [threadRow()]
          : /from action_items/iu.test(sql)
            ? [actionRow()]
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
});

runIfDatabase("PostgresConversationStateRepository with Postgres", () => {
  let pool: pg.Pool | undefined;
  const suffix = postgresSuffix;
  const groupId = postgresGroupId;
  const otherGroupId = postgresOtherGroupId;
  const messageId = postgresMessageId;
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
        ($5, 'feishu', $6, $7, 'bob', 'text', 'Other state evidence.', NOW(), $8)
      `,
      [
        messageId, `provider-${messageId}`, groupId, `event-${messageId}`,
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
    await repository.applyOperations({
      groupId,
      operations: [integrationThreadOperation({
        id: chained.thread!.id, status: "merged", eventType: "merged", operationKey: `chained-merge-${suffix}`,
        expectedVersion: 1, mergedIntoThreadId: leaf.thread!.id,
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
});

type ScriptStep = { pattern: RegExp; rows?: unknown[]; error?: Error };

function step(pattern: RegExp, rows: unknown[] = []): ScriptStep {
  return { pattern, rows };
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
    query: vi.fn(async (sql: string) => {
      const next = queue.shift();
      if (next === undefined) throw new Error(`unexpected query: ${normalize(sql)}`);
      expect(normalize(sql)).toMatch(next.pattern);
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
