import { describe, expect, it, vi } from "vitest";

import {
  createPostgresGroupMemoryRepository,
  type PostgresGroupMemoryDataSource,
  type Queryable,
  type TransactionClient,
} from "../src/memory/postgres-group-memory-repository.js";

describe("createPostgresGroupMemoryRepository", () => {
  it("creates an evidence-bound memory transactionally", async () => {
    const client = scriptedClient([
      step(/begin/u),
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

  it("rolls back a failed correction without superseding the original", async () => {
    const insertionError = new Error("insert failed");
    const client = scriptedClient([
      step(/begin/u),
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
    const source = dataSource(scriptedClient([]), [{ id: "memory-1" }]);
    const repository = createPostgresGroupMemoryRepository({ dataSource: source });

    await expect(repository.deleteById("memory-1")).resolves.toBe("deleted");

    source.query.mockResolvedValueOnce({ rows: [] });
    await expect(repository.deleteById("missing")).resolves.toBe("not_found");
    expect(source.query).toHaveBeenLastCalledWith(
      expect.stringMatching(/delete from group_memories[\s\S]+returning id/iu),
      ["missing"],
    );
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
    evidence_message_ids: ["feishu:msg-1", "feishu:msg-2"],
    created_at: new Date("2026-07-14T00:00:00.000Z"),
    updated_at: new Date("2026-07-14T00:00:00.000Z"),
    ...overrides,
  };
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
