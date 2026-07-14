import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { defaultMigrationsDir, runMigrations } from "../src/database/migrate.js";
import {
  createPostgresMemoryExtractionRepository,
  type PostgresMemoryExtractionDataSource,
  type TransactionClient,
} from "../src/memory-extraction/postgres-memory-extraction-repository.js";

const databaseUrl = process.env.IRIS_TEST_DATABASE_URL?.trim();
const runIfDatabase = databaseUrl ? describe : describe.skip;

describe("createPostgresMemoryExtractionRepository", () => {
  it("requires non-blank text in registration, evidence, and context SQL", async () => {
    const source = fakeDataSource((sql) => {
      const normalized = normalizeSql(sql);
      if (normalized.includes("where r.id = $1")) {
        return { rows: [seedRequestRow({ messageText: "Readable seed" })] };
      }
      if (normalized.includes("and r.status = 'pending'")) {
        return { rows: [evidenceMessageRow()] };
      }
      if (normalized.includes("from conversation_messages cm")) {
        return { rows: [] };
      }
      if (normalized.includes("from group_memories")) {
        return { rows: [] };
      }
      if (normalized.includes("insert into group_memory_extraction_runs")) {
        return {
          rows: [
            {
              id: "run-1",
              group_id: "chat-a",
              input_fingerprint: "f".repeat(64),
              status: "processing",
            },
          ],
        };
      }
      return { rows: [] };
    });
    const repository = createPostgresMemoryExtractionRepository({ dataSource: source.dataSource });

    await repository.claimRun({
      seedRequestId: "request-1",
      maxEvidenceMessages: 40,
      contextMessageLimit: 10,
      activeMemoryLimit: 8,
    });

    const evidenceSql = source.sql.find((sql) => normalizeSql(sql).includes("and r.status = 'pending'"));
    const contextSql = source.sql.find((sql) =>
      normalizeSql(sql).includes("and (cm.created_at, cm.id) <"),
    );
    expect(normalizeSql(evidenceSql ?? "")).toContain(
      "nullif(btrim(cm.text), '') is not null",
    );
    expect(normalizeSql(contextSql ?? "")).toContain(
      "nullif(btrim(cm.text), '') is not null",
    );

    const registrationSource = fakeDataSource(() => ({ rows: [] }));
    const registrationRepository = createPostgresMemoryExtractionRepository({
      dataSource: registrationSource.dataSource,
    });
    await expect(
      registrationRepository.registerRequest({
        groupId: "chat-a",
        conversationMessageId: "feishu:blank",
        providerMessageId: "blank",
      }),
    ).rejects.toThrow();
    expect(normalizeSql(registrationSource.sql[0] ?? "")).toContain(
      "nullif(btrim(cm.text), '') is not null",
    );
  });

  it("skips an unreadable seed without claiming another pending request", async () => {
    const source = fakeDataSource((sql) => {
      const normalized = normalizeSql(sql);
      if (normalized.includes("where r.id = $1")) {
        return { rows: [seedRequestRow({ messageText: "   " })] };
      }
      return { rows: [] };
    });
    const repository = createPostgresMemoryExtractionRepository({ dataSource: source.dataSource });

    await expect(
      repository.claimRun({
        seedRequestId: "request-1",
        maxEvidenceMessages: 40,
        contextMessageLimit: 10,
        activeMemoryLimit: 8,
      }),
    ).resolves.toBeUndefined();

    expect(source.sql.map(normalizeSql)).toContainEqual(
      expect.stringContaining("set status = 'skipped', skip_reason = 'unreadable_message'"),
    );
    expect(source.sql.map(normalizeSql)).not.toContainEqual(
      expect.stringContaining("and r.status = 'pending'"),
    );
  });

  it("locks an existing run before request rows in every same-run transaction", async () => {
    const staleSource = fakeDataSource((sql) => {
      const normalized = normalizeSql(sql);
      if (normalized.includes("from group_memory_extraction_runs") && normalized.includes("for update")) {
        return {
          rows: [
            {
              id: "run-1",
              group_id: "chat-a",
              input_fingerprint: "f".repeat(64),
              status: "processing",
            },
          ],
        };
      }
      return { rows: [] };
    });
    const staleRepository = createPostgresMemoryExtractionRepository({
      dataSource: staleSource.dataSource,
    });
    await staleRepository.loadRunInput("run-1");

    expectRunLockBeforeRequestLock(staleSource.sql);

    const skipSource = fakeDataSource(() => ({ rows: [] }));
    const skipRepository = createPostgresMemoryExtractionRepository({
      dataSource: skipSource.dataSource,
    });
    await skipRepository.skipRun({ runId: "run-1", reason: "policy_denied" });

    expectRunLockBeforeRequestLock(skipSource.sql);

    const claimSource = fakeDataSource((sql) => {
      const normalized = normalizeSql(sql);
      if (normalized.includes("from group_memory_extraction_runs") && normalized.includes("for update")) {
        return {
          rows: [
            {
              id: "run-1",
              group_id: "chat-a",
              input_fingerprint: "f".repeat(64),
              status: "completed",
            },
          ],
        };
      }
      if (normalized.includes("where r.id = $1")) {
        return {
          rows: [
            seedRequestRow({
              status: "processing",
              runId: "run-1",
              messageText: "Readable seed",
            }),
          ],
        };
      }
      return { rows: [] };
    });
    const claimRepository = createPostgresMemoryExtractionRepository({
      dataSource: claimSource.dataSource,
    });
    await claimRepository.claimRun({
      seedRequestId: "request-1",
      maxEvidenceMessages: 40,
      contextMessageLimit: 10,
      activeMemoryLimit: 8,
    });

    expectRunLockBeforeRequestLock(claimSource.sql);
  });

  it("releases the transaction client when BEGIN fails", async () => {
    const beginError = new Error("begin failed");
    const release = vi.fn();
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql === "BEGIN") {
          throw beginError;
        }
        return { rows: [] };
      }),
      release,
    } as unknown as TransactionClient;
    const dataSource = {
      query: vi.fn(async () => ({ rows: [] })),
      connect: vi.fn(async () => client),
    } as unknown as PostgresMemoryExtractionDataSource;
    const repository = createPostgresMemoryExtractionRepository({ dataSource });

    await expect(
      repository.skipRun({ runId: "run-1", reason: "policy_denied" }),
    ).rejects.toBe(beginError);
    expect(release).toHaveBeenCalledOnce();
  });
});

runIfDatabase("PostgresMemoryExtractionRepository with Postgres", () => {
  let pool: pg.Pool | undefined;
  const suffix = randomUUID();
  const groupA = `extraction-group-a-${suffix}`;
  const groupB = `extraction-group-b-${suffix}`;
  const groupIds = [groupA, groupB];
  const contextIds = Array.from(
    { length: 12 },
    (_, index) => `feishu:extraction-context-${index.toString().padStart(2, "0")}-${suffix}`,
  );
  const evidenceIds = Array.from(
    { length: 42 },
    (_, index) => `feishu:extraction-evidence-${index.toString().padStart(2, "0")}-${suffix}`,
  );
  const otherGroupMessageId = `feishu:extraction-other-${suffix}`;
  const unreadableGroup = `extraction-unreadable-${suffix}`;
  const nullTextMessageId = `feishu:extraction-null-text-${suffix}`;
  const blankTextMessageId = `feishu:extraction-blank-text-${suffix}`;
  const readablePeerMessageId = `feishu:extraction-readable-peer-${suffix}`;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl });
    const client = await pool.connect();
    try {
      await runMigrations({ client, migrationsDir: defaultMigrationsDir() });
    } finally {
      client.release();
    }

    for (const [index, id] of [...contextIds, ...evidenceIds].entries()) {
      const isContext = index < contextIds.length;
      const sequence = index + 1;
      await pool.query(
        `
        INSERT INTO conversation_messages (
          id, provider, provider_message_id, chat_id, sender_id,
          message_type, text, sent_at, raw_event_idempotency_key, created_at
        )
        VALUES ($1, 'feishu', $2, $3, $4, 'text', $5, $6, $7, $8)
        `,
        [
          id,
          `provider-${id}`,
          groupA,
          sequence % 2 === 0 ? "alice" : "bob",
          `${isContext ? "Context" : "Evidence"} ${sequence}`,
          new Date(Date.UTC(2026, 6, 14, 0, sequence)),
          `event-${id}`,
          new Date(Date.UTC(2026, 6, 14, 0, sequence)),
        ],
      );
    }

    await pool.query(
      `
      INSERT INTO conversation_messages (
        id, provider, provider_message_id, chat_id, sender_id,
        message_type, text, sent_at, raw_event_idempotency_key, created_at
      )
      VALUES ($1, 'feishu', $2, $3, 'carol', 'text', 'Other group', $4, $5, $4)
      `,
      [
        otherGroupMessageId,
        `provider-${otherGroupMessageId}`,
        groupB,
        new Date("2026-07-14T00:30:00.000Z"),
        `event-${otherGroupMessageId}`,
      ],
    );

    await pool.query(
      `
      INSERT INTO conversation_messages (
        id, provider, provider_message_id, chat_id, sender_id,
        message_type, text, sent_at, raw_event_idempotency_key, created_at
      )
      VALUES
        ($1, 'feishu', $2, $3, 'alice', 'text', NULL, $4, $5, $4),
        ($6, 'feishu', $7, $3, 'alice', 'text', '   ', $8, $9, $8),
        ($10, 'feishu', $11, $3, 'bob', 'text', 'Readable peer', $12, $13, $12)
      `,
      [
        nullTextMessageId,
        `provider-${nullTextMessageId}`,
        unreadableGroup,
        new Date("2026-07-14T03:00:00.000Z"),
        `event-${nullTextMessageId}`,
        blankTextMessageId,
        `provider-${blankTextMessageId}`,
        new Date("2026-07-14T03:01:00.000Z"),
        `event-${blankTextMessageId}`,
        readablePeerMessageId,
        `provider-${readablePeerMessageId}`,
        new Date("2026-07-14T03:02:00.000Z"),
        `event-${readablePeerMessageId}`,
      ],
    );

    for (let index = 0; index < 10; index += 1) {
      await pool.query(
        `
        INSERT INTO group_memories (
          id, group_id, memory_scope, category, content, importance, confidence,
          status, idempotency_key, origin, created_by, request_fingerprint, updated_at
        )
        VALUES ($1, $2, 'group', 'decision', $3, $4, 0.9,
          'active', $5, 'operator', 'test', $6, $7)
        `,
        [
          `extraction-memory-${index.toString().padStart(2, "0")}-${suffix}`,
          groupA,
          `Memory ${index}`,
          (index % 5) + 1,
          `extraction-memory-key-${index}-${suffix}`,
          "0".repeat(64),
          new Date(Date.UTC(2026, 6, 14, 2, index)),
        ],
      );
    }
  });

  afterAll(async () => {
    if (pool === undefined) {
      return;
    }
    try {
      await pool.query(
        `
        DELETE FROM group_memory_extraction_run_evidence
        WHERE run_id IN (
          SELECT id FROM group_memory_extraction_runs WHERE group_id = ANY($1::text[])
        )
        `,
        [[...groupIds, unreadableGroup]],
      );
      await pool.query(
        "DELETE FROM group_memory_extraction_requests WHERE group_id = ANY($1::text[])",
        [[...groupIds, unreadableGroup]],
      );
      await pool.query(
        "DELETE FROM group_memory_extraction_runs WHERE group_id = ANY($1::text[])",
        [[...groupIds, unreadableGroup]],
      );
      await pool.query("DELETE FROM group_memories WHERE group_id = ANY($1::text[])", [
        groupIds,
      ]);
      await pool.query("DELETE FROM conversation_messages WHERE chat_id = ANY($1::text[])", [
        [...groupIds, unreadableGroup],
      ]);
    } finally {
      await pool.end();
    }
  });

  it("registers one durable request for a repeated provider message", async () => {
    const repository = createRepository(pool);
    const input = {
      groupId: groupA,
      conversationMessageId: evidenceIds[1]!,
      providerMessageId: `provider-${evidenceIds[1]}`,
    };

    const first = await repository.registerRequest(input);
    const replay = await repository.registerRequest(input);

    expect(first).toMatchObject({
      created: true,
      request: {
        groupId: groupA,
        conversationMessageId: evidenceIds[1],
        providerMessageId: input.providerMessageId,
        status: "pending",
      },
    });
    expect(replay).toMatchObject({ created: false, request: { id: first.request.id } });
    await expect(
      pool!.query(
        "SELECT count(*)::int AS count FROM group_memory_extraction_requests WHERE provider_message_id = $1",
        [input.providerMessageId],
      ),
    ).resolves.toMatchObject({ rows: [{ count: 1 }] });
  });

  it("fails closed when registration metadata disagrees with the message fact", async () => {
    const repository = createRepository(pool);

    await expect(
      repository.registerRequest({
        groupId: groupB,
        conversationMessageId: evidenceIds[2]!,
        providerMessageId: `provider-${evidenceIds[2]}`,
      }),
    ).rejects.toThrow("conversation message does not match extraction request");
  });

  it("rejects registration for null or blank message text", async () => {
    const repository = createRepository(pool);

    for (const messageId of [nullTextMessageId, blankTextMessageId]) {
      await expect(
        repository.registerRequest({
          groupId: unreadableGroup,
          conversationMessageId: messageId,
          providerMessageId: `provider-${messageId}`,
        }),
      ).rejects.toThrow();
    }

    const result = await pool!.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM group_memory_extraction_requests WHERE group_id = $1",
      [unreadableGroup],
    );
    expect(result.rows).toEqual([{ count: 0 }]);
  });

  it("skips an unreadable legacy seed without claiming its readable peer", async () => {
    const repository = createRepository(pool);
    const badRequestId = `unreadable-request-${suffix}`;
    await pool!.query(
      `
      INSERT INTO group_memory_extraction_requests (
        id, group_id, conversation_message_id, provider_message_id, status
      )
      VALUES ($1, $2, $3, $4, 'pending')
      `,
      [badRequestId, unreadableGroup, blankTextMessageId, `provider-${blankTextMessageId}`],
    );
    const peer = await repository.registerRequest({
      groupId: unreadableGroup,
      conversationMessageId: readablePeerMessageId,
      providerMessageId: `provider-${readablePeerMessageId}`,
    });

    await expect(
      repository.claimRun({
        seedRequestId: badRequestId,
        maxEvidenceMessages: 40,
        contextMessageLimit: 10,
        activeMemoryLimit: 8,
      }),
    ).resolves.toBeUndefined();

    const requests = await pool!.query<{ id: string; status: string; skip_reason: string | null }>(
      `SELECT id, status, skip_reason FROM group_memory_extraction_requests WHERE group_id = $1 ORDER BY id`,
      [unreadableGroup],
    );
    expect(requests.rows).toEqual(
      expect.arrayContaining([
        { id: badRequestId, status: "skipped", skip_reason: "unreadable_message" },
        { id: peer.request.id, status: "pending", skip_reason: null },
      ]),
    );
    await expect(
      pool!.query("SELECT count(*)::int AS count FROM group_memory_extraction_runs WHERE group_id = $1", [
        unreadableGroup,
      ]),
    ).resolves.toMatchObject({ rows: [{ count: 0 }] });
  });

  it("claims a bounded cursor-ordered run without crossing groups", async () => {
    const repository = createRepository(pool);
    const registrationOrder = [...evidenceIds].reverse();
    let seedRequestId = "";
    for (const messageId of registrationOrder) {
      const registered = await repository.registerRequest({
        groupId: groupA,
        conversationMessageId: messageId,
        providerMessageId: `provider-${messageId}`,
      });
      if (messageId === evidenceIds[41]) {
        seedRequestId = registered.request.id;
      }
    }
    const other = await repository.registerRequest({
      groupId: groupB,
      conversationMessageId: otherGroupMessageId,
      providerMessageId: `provider-${otherGroupMessageId}`,
    });

    const run = await repository.claimRun({
      seedRequestId,
      maxEvidenceMessages: 400,
      contextMessageLimit: 100,
      activeMemoryLimit: 80,
    });

    expect(run).toBeDefined();
    expect(run!.groupId).toBe(groupA);
    expect(run!.inputFingerprint).toMatch(/^[0-9a-f]{64}$/u);
    expect(run!.evidenceMessages.map((message) => message.id)).toEqual(
      evidenceIds.slice(0, 40),
    );
    expect(run!.evidenceMessages.every((message) => message.evidenceEligible)).toBe(true);
    expect(run!.contextMessages.map((message) => message.id)).toEqual(contextIds.slice(2));
    expect(run!.contextMessages.every((message) => !message.evidenceEligible)).toBe(true);
    expect(run!.existingMemories).toHaveLength(8);
    expect(new Set([
      ...run!.evidenceMessages.map((message) => message.id),
      ...run!.contextMessages.map((message) => message.id),
    ]).size).toBe(50);
    expect(run!.evidenceMessages.some((message) => message.groupId !== groupA)).toBe(false);
    expect(run!.contextMessages.some((message) => message.groupId !== groupA)).toBe(false);

    const otherRun = await repository.claimRun({
      seedRequestId: other.request.id,
      maxEvidenceMessages: 40,
      contextMessageLimit: 10,
      activeMemoryLimit: 8,
    });
    expect(otherRun).toMatchObject({
      groupId: groupB,
      evidenceMessages: [{ id: otherGroupMessageId }],
    });
  });

  it("reloads unchanged facts and rejects a changed fingerprint as stale", async () => {
    const repository = createRepository(pool);
    const pending = await repository.claimRun({
      seedRequestId: (
        await repository.registerRequest({
          groupId: groupA,
          conversationMessageId: evidenceIds[40]!,
          providerMessageId: `provider-${evidenceIds[40]}`,
        })
      ).request.id,
      maxEvidenceMessages: 1,
      contextMessageLimit: 0,
      activeMemoryLimit: 0,
    });

    expect(pending).toBeDefined();
    await expect(repository.loadRunInput(pending!.id)).resolves.toMatchObject({
      status: "ready",
      run: { inputFingerprint: pending!.inputFingerprint },
    });

    await pool!.query("UPDATE conversation_messages SET text = text || ' changed' WHERE id = $1", [
      pending!.evidenceMessages[0]!.id,
    ]);

    await expect(repository.loadRunInput(pending!.id)).resolves.toEqual({
      status: "stale",
      groupId: groupA,
      requestIds: pending!.requestIds,
    });
  });

  it("skips and fails runs with bounded status counts", async () => {
    const repository = createRepository(pool);
    const remainingRequest = await repository.registerRequest({
      groupId: groupA,
      conversationMessageId: evidenceIds[41]!,
      providerMessageId: `provider-${evidenceIds[41]}`,
    });
    await repository.skipRequest({ requestId: remainingRequest.request.id, reason: "policy_denied" });

    const processingResult = await pool!.query<{ id: string }>(
      `SELECT id FROM group_memory_extraction_runs WHERE group_id = $1 AND status = 'processing' ORDER BY created_at ASC LIMIT 1`,
      [groupA],
    );
    const processingRunId = processingResult.rows[0]!.id;
    await repository.failRun({ runId: processingRunId, classification: "provider_timeout" });

    const otherProcessingResult = await pool!.query<{ id: string }>(
      `SELECT id FROM group_memory_extraction_runs WHERE group_id = $1 AND status = 'processing' ORDER BY created_at ASC LIMIT 1`,
      [groupB],
    );
    const completedRunId = otherProcessingResult.rows[0]!.id;
    await repository.skipRun({ runId: completedRunId, reason: "runtime_disabled_before_apply" });

    await expect(repository.loadRunInput(completedRunId)).resolves.toEqual({
      status: "completed",
    });
    await expect(repository.getStatusCounts()).resolves.toMatchObject({
      skipped: expect.any(Number),
      failedRuns: expect.any(Number),
    });
    const counts = await repository.getStatusCounts();
    expect(counts.skipped).toBeGreaterThanOrEqual(2);
    expect(counts.failedRuns).toBeGreaterThanOrEqual(1);
  });
});

function createRepository(pool: pg.Pool | undefined) {
  if (pool === undefined) {
    throw new Error("Expected Postgres pool to be initialized");
  }
  return createPostgresMemoryExtractionRepository({ dataSource: pool });
}

function fakeDataSource(handler: (sql: string, params?: unknown[]) => { rows: unknown[] }) {
  const sql: string[] = [];
  const query = vi.fn(async (statement: string, params?: unknown[]) => {
    sql.push(statement);
    return handler(statement, params);
  });
  const client = { query, release: vi.fn() } as unknown as TransactionClient;
  const dataSource = {
    query,
    connect: vi.fn(async () => client),
  } as unknown as PostgresMemoryExtractionDataSource;
  return { dataSource, sql };
}

function seedRequestRow(input: {
  messageText: string | null;
  status?: "pending" | "processing";
  runId?: string;
}) {
  return {
    id: "request-1",
    group_id: "chat-a",
    conversation_message_id: "feishu:message-1",
    provider_message_id: "message-1",
    status: input.status ?? "pending",
    run_id: input.runId ?? null,
    skip_reason: null,
    created_at: new Date("2026-07-14T00:00:00.000Z"),
    updated_at: new Date("2026-07-14T00:00:00.000Z"),
    message_group_id: "chat-a",
    message_provider_id: "message-1",
    message_text: input.messageText,
  };
}

function evidenceMessageRow() {
  return {
    request_id: "request-1",
    id: "feishu:message-1",
    chat_id: "chat-a",
    sender_id: "alice",
    text: "Readable seed",
    sent_at: new Date("2026-07-14T00:00:00.000Z"),
    created_at: new Date("2026-07-14T00:00:00.000Z"),
  };
}

function expectRunLockBeforeRequestLock(sql: string[]): void {
  const normalized = sql.map(normalizeSql);
  const runLockIndex = normalized.findIndex(
    (statement) =>
      statement.includes("from group_memory_extraction_runs") &&
      statement.includes("for update"),
  );
  const requestLockIndex = normalized.findIndex(
    (statement) =>
      statement.includes("group_memory_extraction_requests") &&
      (statement.includes("for update") || statement.startsWith("update")),
  );
  expect(runLockIndex).toBeGreaterThanOrEqual(0);
  expect(requestLockIndex).toBeGreaterThan(runLockIndex);
}

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/gu, " ").trim().toLowerCase();
}
