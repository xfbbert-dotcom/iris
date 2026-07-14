import { createHash, randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { defaultMigrationsDir, runMigrations } from "../src/database/migrate.js";
import { MemoryExtractionStaleRunError } from "../src/memory-extraction/memory-extraction-repository.js";
import {
  createPostgresMemoryExtractionRepository,
  type PostgresMemoryExtractionDataSource,
  type TransactionClient,
} from "../src/memory-extraction/postgres-memory-extraction-repository.js";

const databaseUrl = process.env.IRIS_TEST_DATABASE_URL?.trim();
const runIfDatabase = databaseUrl ? describe : describe.skip;

describe("createPostgresMemoryExtractionRepository", () => {
  it("looks up canonical durable request routes without selecting chat content", async () => {
    const source = fakeDataSource((sql, params) => {
      expect(normalizeSql(sql)).toContain(
        "select r.id, r.group_id, r.status, r.run_id",
      );
      expect(normalizeSql(sql)).not.toContain("cm.text");
      expect(params).toEqual([["request-1", "request-2"]]);
      return {
        rows: [
          {
            id: "request-1",
            group_id: "chat-a",
            status: "pending",
            run_id: null,
          },
          {
            id: "request-2",
            group_id: "chat-b",
            status: "processing",
            run_id: "run-2",
          },
        ],
      };
    });
    const repository = createPostgresMemoryExtractionRepository({ dataSource: source.dataSource });
    const requestIds = ["request-2", "request-1"];

    await expect(repository.getRequestRoutes({ requestIds })).resolves.toEqual([
      { requestId: "request-1", groupId: "chat-a", status: "pending" },
      {
        requestId: "request-2",
        groupId: "chat-b",
        status: "processing",
        runId: "run-2",
      },
    ]);
    expect(requestIds).toEqual(["request-2", "request-1"]);
    await expect(
      repository.getRequestRoutes({
        requestIds: Array.from({ length: 101 }, (_, index) => `request-${index}`),
      }),
    ).rejects.toThrow("requestIds must contain at most 100 identifiers");
  });

  it("uses exact request ids for claims and one POSIX whitespace predicate for SQL reads", async () => {
    const source = fakeDataSource((sql) => {
      const normalized = normalizeSql(sql);
      if (
        normalized.includes("select r.id, r.group_id, r.status, r.run_id") &&
        !normalized.includes("for update")
      ) {
        return { rows: [requestRouteRow()] };
      }
      if (normalized.includes("for update of r skip locked")) {
        return { rows: [claimMessageRow()] };
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
      if (normalized.startsWith("update group_memory_extraction_requests")) {
        return { rows: [{ id: "request-1" }] };
      }
      return { rows: [] };
    });
    const repository = createPostgresMemoryExtractionRepository({ dataSource: source.dataSource });

    await repository.claimRun({
      requestIds: ["request-1"],
      maxEvidenceMessages: 40,
      contextMessageLimit: 10,
      activeMemoryLimit: 8,
    });

    const claimSql = source.sql.find((sql) =>
      normalizeSql(sql).includes("for update of r skip locked"),
    );
    const contextSql = source.sql.find((sql) =>
      normalizeSql(sql).includes("and (cm.created_at, cm.id) <"),
    );
    const readableTextPredicate = "cm.text ~ '[^[:space:]]'";
    expect(normalizeSql(claimSql ?? "")).toContain("where r.id = any($1::text[])");
    expect(normalizeSql(claimSql ?? "")).not.toContain("where r.group_id =");
    expect(normalizeSql(contextSql ?? "")).toContain(readableTextPredicate);

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
    expect(normalizeSql(registrationSource.sql[0] ?? "")).toContain(readableTextPredicate);
  });

  it.each([
    {
      name: "moved group",
      messageGroupId: "chat-b",
      messageProviderId: "message-1",
    },
    {
      name: "changed provider identity",
      messageGroupId: "chat-a",
      messageProviderId: "message-2",
    },
  ])("fails closed on idempotent replay after $name", async ({ messageGroupId, messageProviderId }) => {
    const source = fakeDataSource((sql) => {
      if (normalizeSql(sql).startsWith("insert into group_memory_extraction_requests")) {
        return { rows: [] };
      }
      return {
        rows: [existingRequestRow({ messageGroupId, messageProviderId })],
      };
    });
    const repository = createPostgresMemoryExtractionRepository({ dataSource: source.dataSource });

    await expect(
      repository.registerRequest({
        groupId: "chat-a",
        conversationMessageId: "feishu:message-1",
        providerMessageId: "message-1",
      }),
    ).rejects.toThrow("conversation message does not match extraction request");
  });

  it.each([
    { label: "space", messageText: "   " },
    { label: "tab", messageText: "\t\t" },
    { label: "newline", messageText: "\n\n" },
  ])("skips a $label-only seed without claiming another pending request", async ({ messageText }) => {
    const source = fakeDataSource((sql) => {
      const normalized = normalizeSql(sql);
      if (normalized.includes("select r.id, r.group_id, r.status, r.run_id")) {
        return { rows: [requestRouteRow()] };
      }
      if (normalized.includes("for update of r skip locked")) {
        return { rows: [claimMessageRow({ messageText })] };
      }
      return { rows: [] };
    });
    const repository = createPostgresMemoryExtractionRepository({ dataSource: source.dataSource });

    await expect(
      repository.claimRun({
        requestIds: ["request-1"],
        maxEvidenceMessages: 40,
        contextMessageLimit: 10,
        activeMemoryLimit: 8,
      }),
    ).resolves.toBeUndefined();

    expect(source.sql.map(normalizeSql)).toContainEqual(
      expect.stringContaining("set status = 'skipped', skip_reason = 'unreadable_message'"),
    );
    expect(source.sql.map(normalizeSql)).not.toContainEqual(
      expect.stringContaining("insert into group_memory_extraction_runs"),
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
      if (normalized.includes("select r.id, r.group_id, r.status, r.run_id")) {
        return { rows: [requestRouteRow({ status: "processing", runId: "run-1" })] };
      }
      if (normalized.includes("for update of r skip locked")) {
        return { rows: [claimMessageRow({ status: "processing", runId: "run-1" })] };
      }
      return { rows: [] };
    });
    const claimRepository = createPostgresMemoryExtractionRepository({
      dataSource: claimSource.dataSource,
    });
    await claimRepository.claimRun({
      requestIds: ["request-1"],
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

  it("permanently skips an already-processing run from a request without reversing lock order", async () => {
    const source = fakeDataSource((sql) => {
      const normalized = normalizeSql(sql);
      if (
        normalized.startsWith("select run_id, status") &&
        normalized.includes("from group_memory_extraction_requests")
      ) {
        return { rows: [{ run_id: "run-1", status: "processing" }] };
      }
      if (
        normalized.includes("from group_memory_extraction_runs") &&
        normalized.includes("for update")
      ) {
        return { rows: [completionRunRow()] };
      }
      if (
        normalized.includes("from group_memory_extraction_requests") &&
        normalized.includes("order by id asc") &&
        normalized.includes("for update")
      ) {
        return {
          rows: [
            { id: "request-1", status: "processing", run_id: "run-1" },
            { id: "request-2", status: "processing", run_id: "run-1" },
          ],
        };
      }
      return { rows: [] };
    });
    const repository = createPostgresMemoryExtractionRepository({ dataSource: source.dataSource });

    await repository.skipRequest({
      requestId: "request-1",
      reason: "runtime_disabled_before_load",
    });

    const statements = source.sql.map(normalizeSql);
    const runLock = statements.findIndex(
      (sql) => sql.includes("from group_memory_extraction_runs") && sql.includes("for update"),
    );
    const requestLock = statements.findIndex(
      (sql) =>
        sql.includes("from group_memory_extraction_requests") &&
        sql.includes("order by id asc") &&
        sql.includes("for update"),
    );
    expect(runLock).toBeGreaterThanOrEqual(0);
    expect(requestLock).toBeGreaterThan(runLock);
    expect(statements).toContainEqual(
      expect.stringContaining("set status = 'skipped', skip_reason = $2"),
    );
    expect(statements).toContainEqual(
      expect.stringContaining("set status = 'completed', failure_classification = $2"),
    );
  });

  it("commits a stale processing-run reset and signals the worker to retry", async () => {
    const source = fakeDataSource((sql) => {
      const normalized = normalizeSql(sql);
      if (normalized.includes("select r.id, r.group_id, r.status, r.run_id")) {
        return { rows: [requestRouteRow({ status: "processing", runId: "run-1" })] };
      }
      if (normalized.includes("for update of r skip locked")) {
        return { rows: [claimMessageRow({ status: "processing", runId: "run-1" })] };
      }
      if (
        normalized.includes("from group_memory_extraction_runs") &&
        normalized.includes("for update")
      ) {
        return { rows: [completionRunRow()] };
      }
      return { rows: [] };
    });
    const repository = createPostgresMemoryExtractionRepository({ dataSource: source.dataSource });

    await expect(
      repository.claimRun({
        requestIds: ["request-1"],
        maxEvidenceMessages: 40,
        contextMessageLimit: 10,
        activeMemoryLimit: 8,
      }),
    ).rejects.toBeInstanceOf(MemoryExtractionStaleRunError);

    const statements = source.sql.map(normalizeSql);
    expect(statements).toContainEqual(
      expect.stringContaining("failure_classification = 'input_stale'"),
    );
    expect(statements).toContainEqual(
      expect.stringContaining("set status = 'pending', run_id = null"),
    );
    expect(statements).toContain("commit");
  });

  it("reclaims an existing multi-request run from a covered retry subset", async () => {
    const storedEvidence = storedEvidenceRows();
    const inputFingerprint = storedInputFingerprint(storedEvidence);
    const source = fakeDataSource((sql) => {
      const normalized = normalizeSql(sql);
      if (
        normalized.includes("select r.id, r.group_id, r.status, r.run_id") &&
        !normalized.includes("for update")
      ) {
        return { rows: [requestRouteRow({ status: "processing", runId: "run-1" })] };
      }
      if (
        normalized.includes("from group_memory_extraction_runs") &&
        normalized.includes("for update")
      ) {
        return {
          rows: [completionRunRow({
            input_fingerprint: inputFingerprint,
            status: "failed",
            failure_classification: "provider_unauthorized",
          })],
        };
      }
      if (normalized.includes("from group_memory_extraction_run_evidence e")) {
        return { rows: storedEvidence };
      }
      if (normalized.includes("from group_memory_extraction_run_context c")) {
        return { rows: [] };
      }
      if (normalized.includes("from group_memory_extraction_run_memories rm")) {
        return { rows: [] };
      }
      if (normalized.includes("for update of r skip locked")) {
        return { rows: [claimMessageRow({ status: "processing", runId: "run-1" })] };
      }
      return { rows: [] };
    });
    const repository = createPostgresMemoryExtractionRepository({ dataSource: source.dataSource });

    await expect(
      repository.claimRun({
        requestIds: ["request-1"],
        maxEvidenceMessages: 40,
        contextMessageLimit: 10,
        activeMemoryLimit: 8,
      }),
    ).resolves.toMatchObject({
      id: "run-1",
      requestIds: ["request-1", "request-2"],
      previousFailureClassification: "provider_unauthorized",
    });
  });

  it("locks a run and its claimed requests before atomically inserting canonical memories", async () => {
    let memoryInsertCount = 0;
    const storedEvidence = storedEvidenceRows();
    const inputFingerprint = storedInputFingerprint(storedEvidence);
    const source = fakeDataSource((sql, params) => {
      const normalized = normalizeSql(sql);
      if (
        normalized.includes("from group_memory_extraction_runs") &&
        normalized.includes("for update")
      ) {
        return { rows: [completionRunRow({ input_fingerprint: inputFingerprint })] };
      }
      if (normalized.includes("from group_memory_extraction_run_evidence e")) {
        if (normalized.includes("as stored_message_id")) {
          return { rows: storedEvidence };
        }
        return {
          rows: [
            completionEvidenceRow("request-1", "feishu:msg-1", 0),
            completionEvidenceRow("request-2", "feishu:msg-2", 1),
          ],
        };
      }
      if (
        normalized.includes("from group_memory_extraction_run_context") ||
        normalized.includes("from group_memory_extraction_run_memories")
      ) {
        return { rows: [] };
      }
      if (normalized.includes("from group_memories") && normalized.includes("idempotency_key")) {
        return { rows: [] };
      }
      if (normalized.startsWith("select cm.id from conversation_messages")) {
        return { rows: storedEvidence.map(({ id }) => ({ id })) };
      }
      if (normalized.includes("from conversation_messages")) {
        const evidenceIds = params?.[0] as string[];
        return {
          rows: evidenceIds.map((id) => ({ id, chat_id: "chat-a" })),
        };
      }
      if (normalized.startsWith("insert into group_memories")) {
        memoryInsertCount += 1;
        return { rows: [insertedMemoryRow(params ?? [])] };
      }
      if (normalized.startsWith("update group_memory_extraction_requests")) {
        return { rows: [{ id: "request-1" }, { id: "request-2" }] };
      }
      if (normalized.startsWith("update group_memory_extraction_runs")) {
        return { rows: [{ id: "run-1" }] };
      }
      return { rows: [] };
    });
    const repository = createPostgresMemoryExtractionRepository({ dataSource: source.dataSource });
    const acceptedCandidates = [
      validatedCandidate({
        category: "workflow",
        content: "Use the release checklist.",
        evidenceMessageIds: ["feishu:msg-2"],
      }),
      validatedCandidate({
        category: "decision",
        content: "Launch on Thursday.",
        evidenceMessageIds: ["feishu:msg-1"],
      }),
    ];
    const acceptedSnapshot = structuredClone(acceptedCandidates);

    const result = await repository.completeRun({
      runId: "run-1",
      inputFingerprint,
      acceptedCandidates,
      diagnostics: diagnostics({ acceptedCount: 2, proposedCount: 2 }),
    });

    expect(result).toEqual({
      status: "completed",
      memoryIds: expect.arrayContaining([expect.any(String), expect.any(String)]),
    });
    expect(result.memoryIds).toHaveLength(2);
    expect(memoryInsertCount).toBe(2);
    expect(acceptedCandidates).toEqual(acceptedSnapshot);

    const normalized = source.sql.map(normalizeSql);
    const runLock = normalized.findIndex(
      (sql) => sql.includes("from group_memory_extraction_runs") && sql.includes("for update"),
    );
    const requestLock = normalized.findIndex((sql) =>
      sql.includes("from group_memory_extraction_run_evidence e"),
    );
    const firstMemoryInsert = normalized.findIndex((sql) =>
      sql.startsWith("insert into group_memories"),
    );
    expect(runLock).toBeGreaterThanOrEqual(0);
    expect(requestLock).toBeGreaterThan(runLock);
    expect(firstMemoryInsert).toBeGreaterThan(requestLock);

    const insertCalls = source.query.mock.calls.filter(([sql]) =>
      normalizeSql(String(sql)).startsWith("insert into group_memories"),
    );
    expect(insertCalls.map(([, params]) => params?.[5])).toEqual([
      "Launch on Thursday.",
      "Use the release checklist.",
    ]);
    expect(insertCalls.map(([, params]) => params?.[8])).toEqual([
      sha256("run-1" + "0"),
      sha256("run-1" + "1"),
    ]);
  });

  it("rolls back every memory and state transition when a later candidate insert fails", async () => {
    const insertFailure = new Error("synthetic insert failure");
    let memoryInsertCount = 0;
    const storedEvidence = storedEvidenceRows();
    const inputFingerprint = storedInputFingerprint(storedEvidence);
    const source = fakeDataSource((sql, params) => {
      const normalized = normalizeSql(sql);
      if (
        normalized.includes("from group_memory_extraction_runs") &&
        normalized.includes("for update")
      ) {
        return { rows: [completionRunRow({ input_fingerprint: inputFingerprint })] };
      }
      if (normalized.includes("from group_memory_extraction_run_evidence e")) {
        if (normalized.includes("as stored_message_id")) {
          return { rows: storedEvidence };
        }
        return {
          rows: [
            completionEvidenceRow("request-1", "feishu:msg-1", 0),
            completionEvidenceRow("request-2", "feishu:msg-2", 1),
          ],
        };
      }
      if (
        normalized.includes("from group_memory_extraction_run_context") ||
        normalized.includes("from group_memory_extraction_run_memories")
      ) {
        return { rows: [] };
      }
      if (normalized.includes("from group_memories") && normalized.includes("idempotency_key")) {
        return { rows: [] };
      }
      if (normalized.startsWith("select cm.id from conversation_messages")) {
        return { rows: storedEvidence.map(({ id }) => ({ id })) };
      }
      if (normalized.includes("from conversation_messages")) {
        return {
          rows: ((params?.[0] as string[]) ?? []).map((id) => ({ id, chat_id: "chat-a" })),
        };
      }
      if (normalized.startsWith("insert into group_memories")) {
        memoryInsertCount += 1;
        if (memoryInsertCount === 2) {
          throw insertFailure;
        }
        return { rows: [insertedMemoryRow(params ?? [])] };
      }
      return { rows: [] };
    });
    const repository = createPostgresMemoryExtractionRepository({ dataSource: source.dataSource });

    await expect(
      repository.completeRun({
        runId: "run-1",
        inputFingerprint,
        acceptedCandidates: [
          validatedCandidate({ content: "Candidate A." }),
          validatedCandidate({ category: "workflow", content: "Candidate B." }),
        ],
        diagnostics: diagnostics({ acceptedCount: 2, proposedCount: 2 }),
      }),
    ).rejects.toBe(insertFailure);

    expect(source.sql.map(normalizeSql)).toContain("rollback");
    expect(source.sql.map(normalizeSql)).not.toContainEqual(
      expect.stringMatching(/^update group_memory_extraction_(requests|runs)/u),
    );
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
  const tabTextMessageId = `feishu:extraction-tab-text-${suffix}`;
  const newlineTextMessageId = `feishu:extraction-newline-text-${suffix}`;
  const newlineContextMessageId = `feishu:extraction-newline-context-${suffix}`;
  const readablePeerMessageId = `feishu:extraction-readable-peer-${suffix}`;
  const identityGroup = `extraction-identity-${suffix}`;
  const identityMessageId = `feishu:extraction-identity-${suffix}`;

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
        ($1, 'feishu', $2, $3, 'alice', 'text', $4, $5, $6, $5),
        ($7, 'feishu', $8, $3, 'alice', 'text', $9, $10, $11, $10),
        ($12, 'feishu', $13, $14, 'alice', 'text', $15, $16, $17, $16),
        ($18, 'feishu', $19, $20, 'alice', 'text', 'Identity message', $21, $22, $21)
      `,
      [
        tabTextMessageId,
        `provider-${tabTextMessageId}`,
        unreadableGroup,
        "\t\t",
        new Date("2026-07-14T03:03:00.000Z"),
        `event-${tabTextMessageId}`,
        newlineTextMessageId,
        `provider-${newlineTextMessageId}`,
        "\n\n",
        new Date("2026-07-14T03:04:00.000Z"),
        `event-${newlineTextMessageId}`,
        newlineContextMessageId,
        `provider-${newlineContextMessageId}`,
        groupA,
        "\n",
        new Date("2026-07-14T00:12:30.000Z"),
        `event-${newlineContextMessageId}`,
        identityMessageId,
        `provider-${identityMessageId}`,
        identityGroup,
        new Date("2026-07-14T04:00:00.000Z"),
        `event-${identityMessageId}`,
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
        [[...groupIds, unreadableGroup, identityGroup]],
      );
      await pool.query(
        "DELETE FROM group_memory_extraction_requests WHERE group_id = ANY($1::text[])",
        [[...groupIds, unreadableGroup, identityGroup]],
      );
      await pool.query(
        "DELETE FROM group_memory_extraction_runs WHERE group_id = ANY($1::text[])",
        [[...groupIds, unreadableGroup, identityGroup]],
      );
      await pool.query("DELETE FROM group_memories WHERE group_id = ANY($1::text[])", [
        groupIds,
      ]);
      await pool.query("DELETE FROM conversation_messages WHERE chat_id = ANY($1::text[])", [
        [...groupIds, unreadableGroup, identityGroup],
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

  it("fails closed when authoritative replay identity has changed", async () => {
    const repository = createRepository(pool);
    const input = {
      groupId: identityGroup,
      conversationMessageId: identityMessageId,
      providerMessageId: `provider-${identityMessageId}`,
    };
    await repository.registerRequest(input);

    await pool!.query("UPDATE conversation_messages SET chat_id = $2 WHERE id = $1", [
      identityMessageId,
      `${identityGroup}-moved`,
    ]);
    try {
      await expect(repository.registerRequest(input)).rejects.toThrow(
        "conversation message does not match extraction request",
      );
    } finally {
      await pool!.query("UPDATE conversation_messages SET chat_id = $2 WHERE id = $1", [
        identityMessageId,
        identityGroup,
      ]);
    }

    await pool!.query("UPDATE conversation_messages SET provider_message_id = $2 WHERE id = $1", [
      identityMessageId,
      `${input.providerMessageId}-changed`,
    ]);
    try {
      await expect(repository.registerRequest(input)).rejects.toThrow(
        "conversation message does not match extraction request",
      );
    } finally {
      await pool!.query("UPDATE conversation_messages SET provider_message_id = $2 WHERE id = $1", [
        identityMessageId,
        input.providerMessageId,
      ]);
    }
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

  it("rejects registration for null or whitespace-only message text", async () => {
    const repository = createRepository(pool);

    for (const messageId of [
      nullTextMessageId,
      blankTextMessageId,
      tabTextMessageId,
      newlineTextMessageId,
    ]) {
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
      [badRequestId, unreadableGroup, tabTextMessageId, `provider-${tabTextMessageId}`],
    );
    const peer = await repository.registerRequest({
      groupId: unreadableGroup,
      conversationMessageId: readablePeerMessageId,
      providerMessageId: `provider-${readablePeerMessageId}`,
    });

    await expect(
      repository.claimRun({
        requestIds: [badRequestId],
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
    const requestIdsByMessageId = new Map<string, string>();
    for (const messageId of registrationOrder) {
      const registered = await repository.registerRequest({
        groupId: groupA,
        conversationMessageId: messageId,
        providerMessageId: `provider-${messageId}`,
      });
      requestIdsByMessageId.set(messageId, registered.request.id);
    }
    const other = await repository.registerRequest({
      groupId: groupB,
      conversationMessageId: otherGroupMessageId,
      providerMessageId: `provider-${otherGroupMessageId}`,
    });

    const run = await repository.claimRun({
      requestIds: evidenceIds.slice(0, 40).map((messageId) => requestIdsByMessageId.get(messageId)!),
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
      requestIds: [other.request.id],
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
      requestIds: [(
        await repository.registerRequest({
          groupId: groupA,
          conversationMessageId: evidenceIds[40]!,
          providerMessageId: `provider-${evidenceIds[40]}`,
        })
      ).request.id],
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

runIfDatabase("PostgresMemoryExtractionRepository atomic completion with Postgres", () => {
  let pool: pg.Pool | undefined;
  const suffix = randomUUID();
  const groupId = `extraction-complete-${suffix}`;
  const messageIds = Array.from(
    { length: 4 },
    (_, index) => `feishu:extraction-complete-${index}-${suffix}`,
  );

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl });
    const client = await pool.connect();
    try {
      await runMigrations({ client, migrationsDir: defaultMigrationsDir() });
    } finally {
      client.release();
    }
    for (const [index, messageId] of messageIds.entries()) {
      await pool.query(
        `
        INSERT INTO conversation_messages (
          id, provider, provider_message_id, chat_id, sender_id,
          message_type, text, sent_at, raw_event_idempotency_key, created_at
        )
        VALUES ($1, 'feishu', $2, $3, 'alice', 'text', $4, $5, $6, $5)
        `,
        [
          messageId,
          `provider-${messageId}`,
          groupId,
          `Atomic message ${index}`,
          new Date(Date.UTC(2026, 6, 15, 1, index)),
          `event-${messageId}`,
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
          SELECT id FROM group_memory_extraction_runs WHERE group_id = $1
        )
        `,
        [groupId],
      );
      await pool.query("DELETE FROM group_memory_extraction_requests WHERE group_id = $1", [
        groupId,
      ]);
      await pool.query("DELETE FROM group_memory_extraction_runs WHERE group_id = $1", [groupId]);
      await pool.query("DELETE FROM group_memories WHERE group_id = $1", [groupId]);
      await pool.query("DELETE FROM conversation_messages WHERE chat_id = $1", [groupId]);
    } finally {
      await pool.end();
    }
  });

  it("commits accepted memories, evidence, diagnostics, requests, and run as one replay-safe unit", async () => {
    const repository = createRepository(pool);
    const requests = [];
    for (const messageId of messageIds.slice(0, 2)) {
      requests.push(
        await repository.registerRequest({
          groupId,
          conversationMessageId: messageId,
          providerMessageId: `provider-${messageId}`,
        }),
      );
    }
    const claimed = await repository.claimRun({
      requestIds: requests.map(({ request }) => request.id),
      maxEvidenceMessages: 40,
      contextMessageLimit: 0,
      activeMemoryLimit: 0,
    });
    expect(claimed).toBeDefined();
    const acceptedCandidates = [
      validatedCandidate({
        category: "workflow",
        content: "Use the atomic release checklist.",
        evidenceMessageIds: [messageIds[1]!],
      }),
      validatedCandidate({
        content: "Launch atomically on Thursday.",
        evidenceMessageIds: [messageIds[0]!],
      }),
    ];
    const completionInput = {
      runId: claimed!.id,
      inputFingerprint: claimed!.inputFingerprint,
      acceptedCandidates,
      diagnostics: diagnostics({ proposedCount: 2, acceptedCount: 2 }),
    };

    const completed = await repository.completeRun(completionInput);
    expect(completed.status).toBe("completed");
    expect(completed.memoryIds).toHaveLength(2);

    const replayed = await repository.completeRun(completionInput);
    expect(replayed).toEqual({
      status: "already_completed",
      memoryIds: completed.memoryIds,
    });
    await expect(
      repository.completeRun({
        ...completionInput,
        inputFingerprint: "0".repeat(64),
      }),
    ).rejects.toThrow("memory extraction completion conflicts with persisted run");
    await expect(
      repository.completeRun({
        ...completionInput,
        acceptedCandidates: [acceptedCandidates[0]!],
        diagnostics: diagnostics({ proposedCount: 1, acceptedCount: 1 }),
      }),
    ).rejects.toThrow("memory extraction completion conflicts with persisted run");

    const memories = await pool!.query<{
      id: string;
      idempotency_key: string;
      origin: string;
      created_by: string;
    }>(
      `
      SELECT id, idempotency_key, origin, created_by
      FROM group_memories
      WHERE group_id = $1 AND id = ANY($2::text[])
      ORDER BY idempotency_key ASC
      `,
      [groupId, completed.memoryIds],
    );
    expect(memories.rows.map((row) => row.idempotency_key).sort()).toEqual(
      [sha256(claimed!.id + "0"), sha256(claimed!.id + "1")].sort(),
    );
    expect(memories.rows.every((row) => row.origin === "extractor")).toBe(true);
    expect(memories.rows.every((row) => row.created_by === "memory-extraction-worker")).toBe(
      true,
    );

    const evidence = await pool!.query<{ memory_id: string; conversation_message_id: string }>(
      `
      SELECT memory_id, conversation_message_id
      FROM group_memory_message_evidence
      WHERE memory_id = ANY($1::text[])
      ORDER BY memory_id, conversation_message_id
      `,
      [completed.memoryIds],
    );
    expect(evidence.rows).toHaveLength(2);
    expect(evidence.rows.map((row) => row.conversation_message_id).sort()).toEqual(
      messageIds.slice(0, 2).sort(),
    );

    const requestRows = await pool!.query<{ status: string }>(
      "SELECT status FROM group_memory_extraction_requests WHERE run_id = $1 ORDER BY id",
      [claimed!.id],
    );
    expect(requestRows.rows.every((row) => row.status === "completed")).toBe(true);
    const runRow = await pool!.query<{
      status: string;
      failure_classification: string;
      completed_at: Date | null;
    }>(
      `
      SELECT status, failure_classification, completed_at
      FROM group_memory_extraction_runs
      WHERE id = $1
      `,
      [claimed!.id],
    );
    expect(runRow.rows[0]).toMatchObject({ status: "completed" });
    expect(runRow.rows[0]!.completed_at).toBeInstanceOf(Date);
    expect(runRow.rows[0]!.failure_classification.length).toBeLessThanOrEqual(128);
    expect(runRow.rows[0]!.failure_classification).not.toContain("Launch atomically");
  });

  it("completes an accepted-empty run without inserting a memory", async () => {
    const repository = createRepository(pool);
    const registered = await repository.registerRequest({
      groupId,
      conversationMessageId: messageIds[2]!,
      providerMessageId: `provider-${messageIds[2]}`,
    });
    const claimed = await repository.claimRun({
      requestIds: [registered.request.id],
      maxEvidenceMessages: 1,
      contextMessageLimit: 0,
      activeMemoryLimit: 0,
    });
    expect(claimed).toBeDefined();

    const completion = {
      runId: claimed!.id,
      inputFingerprint: claimed!.inputFingerprint,
      acceptedCandidates: [],
      diagnostics: {
        proposedCount: 1,
        acceptedCount: 0,
        rejectedCount: 1,
        duplicateCount: 0,
        conflictCount: 0,
        rejectionCodes: ["low_confidence"],
      },
    };
    await expect(repository.completeRun(completion)).resolves.toEqual({
      status: "completed",
      memoryIds: [],
    });
    const marker = await pool!.query<{ failure_classification: string }>(
      "SELECT failure_classification FROM group_memory_extraction_runs WHERE id = $1",
      [claimed!.id],
    );
    expect(marker.rows[0]!.failure_classification).toMatch(
      /^v2:p1:a0:r1:d0:c0:xlow_confidence:h[A-Za-z0-9_-]{43}$/u,
    );
    await expect(repository.completeRun(completion)).resolves.toEqual({
      status: "already_completed",
      memoryIds: [],
    });
    await expect(
      repository.completeRun({
        ...completion,
        diagnostics: { ...completion.diagnostics, rejectionCodes: ["invalid_content"] },
      }),
    ).rejects.toThrow("memory extraction completion conflicts with persisted run");
    await expect(repository.loadRunInput(claimed!.id)).resolves.toEqual({
      status: "completed",
    });
  });

  it("rolls back an earlier accepted memory when a later idempotency key conflicts", async () => {
    const repository = createRepository(pool);
    const registered = await repository.registerRequest({
      groupId,
      conversationMessageId: messageIds[3]!,
      providerMessageId: `provider-${messageIds[3]}`,
    });
    const claimed = await repository.claimRun({
      requestIds: [registered.request.id],
      maxEvidenceMessages: 1,
      contextMessageLimit: 0,
      activeMemoryLimit: 0,
    });
    expect(claimed).toBeDefined();
    const conflictingId = `conflicting-memory-${suffix}`;
    await pool!.query(
      `
      INSERT INTO group_memories (
        id, group_id, memory_scope, category, content, importance, confidence,
        status, idempotency_key, origin, created_by, request_fingerprint
      )
      VALUES ($1, $2, 'group', 'workflow', 'Conflicting prior memory', 4, 0.9,
        'active', $3, 'operator', 'test', $4)
      `,
      [conflictingId, groupId, sha256(claimed!.id + "1"), "0".repeat(64)],
    );
    await pool!.query(
      `
      INSERT INTO group_memory_message_evidence (memory_id, conversation_message_id)
      VALUES ($1, $2)
      `,
      [conflictingId, messageIds[3]],
    );

    await expect(
      repository.completeRun({
        runId: claimed!.id,
        inputFingerprint: claimed!.inputFingerprint,
        acceptedCandidates: [
          validatedCandidate({
            content: "First atomic candidate.",
            evidenceMessageIds: [messageIds[3]!],
          }),
          validatedCandidate({
            category: "workflow",
            content: "Second atomic candidate.",
            evidenceMessageIds: [messageIds[3]!],
          }),
        ],
        diagnostics: diagnostics({ proposedCount: 2, acceptedCount: 2 }),
      }),
    ).rejects.toThrow("group memory idempotency key conflicts with another operation");

    await expect(
      pool!.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM group_memories WHERE group_id = $1 AND idempotency_key = $2",
        [groupId, sha256(claimed!.id + "0")],
      ),
    ).resolves.toMatchObject({ rows: [{ count: 0 }] });
    await expect(
      pool!.query("SELECT status FROM group_memory_extraction_runs WHERE id = $1", [claimed!.id]),
    ).resolves.toMatchObject({ rows: [{ status: "processing" }] });
    await expect(
      pool!.query("SELECT status FROM group_memory_extraction_requests WHERE id = $1", [
        registered.request.id,
      ]),
    ).resolves.toMatchObject({ rows: [{ status: "processing" }] });

    await repository.skipRequest({
      requestId: registered.request.id,
      reason: "runtime_disabled_before_load",
    });
    await expect(
      pool!.query("SELECT status FROM group_memory_extraction_runs WHERE id = $1", [claimed!.id]),
    ).resolves.toMatchObject({ rows: [{ status: "completed" }] });
    await expect(
      pool!.query("SELECT status, skip_reason FROM group_memory_extraction_requests WHERE id = $1", [
        registered.request.id,
      ]),
    ).resolves.toMatchObject({
      rows: [{ status: "skipped", skip_reason: "runtime_disabled_before_load" }],
    });
  });
});

runIfDatabase("PostgresMemoryExtractionRepository review invariants with Postgres", () => {
  let pool: pg.Pool | undefined;
  const suffix = randomUUID();
  const groupPrefix = `extraction-review-${suffix}`;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl });
    const client = await pool.connect();
    try {
      await runMigrations({ client, migrationsDir: defaultMigrationsDir() });
    } finally {
      client.release();
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
          SELECT id FROM group_memory_extraction_runs WHERE group_id LIKE $1
        )
        `,
        [`${groupPrefix}%`],
      );
      await pool.query("DELETE FROM group_memory_extraction_requests WHERE group_id LIKE $1", [
        `${groupPrefix}%`,
      ]);
      await pool.query("DELETE FROM group_memory_extraction_runs WHERE group_id LIKE $1", [
        `${groupPrefix}%`,
      ]);
      await pool.query(
        `
        DELETE FROM group_memory_message_evidence
        WHERE memory_id IN (SELECT id FROM group_memories WHERE group_id LIKE $1)
        `,
        [`${groupPrefix}%`],
      );
      await pool.query("DELETE FROM group_memories WHERE group_id LIKE $1", [`${groupPrefix}%`]);
      await pool.query("DELETE FROM conversation_messages WHERE chat_id LIKE $1", [
        `${groupPrefix}%`,
      ]);
    } finally {
      await pool.end();
    }
  });

  it("claims exactly the dequeued request ids and preserves that scope through stale recovery", async () => {
    const repository = createRepository(pool);
    const groupId = `${groupPrefix}-scope`;
    const requests = [];
    for (let index = 0; index < 3; index += 1) {
      const messageId = `feishu:${groupId}-${index}`;
      await insertExtractionMessage(pool!, {
        id: messageId,
        groupId,
        text: `Scoped message ${index}`,
        createdAt: new Date(Date.UTC(2026, 6, 15, 4, index)),
      });
      requests.push(
        await repository.registerRequest({
          groupId,
          conversationMessageId: messageId,
          providerMessageId: `provider-${messageId}`,
        }),
      );
    }
    const coveredRequestIds = requests.slice(0, 2).map(({ request }) => request.id).reverse();

    const claimed = await repository.claimRun({
      requestIds: coveredRequestIds,
      maxEvidenceMessages: 40,
      contextMessageLimit: 0,
      activeMemoryLimit: 0,
    });

    expect(claimed).toBeDefined();
    expect(new Set(claimed!.requestIds)).toEqual(new Set(coveredRequestIds));
    await expect(
      pool!.query<{ id: string; status: string; run_id: string | null }>(
        "SELECT id, status, run_id FROM group_memory_extraction_requests WHERE group_id = $1 ORDER BY created_at, id",
        [groupId],
      ),
    ).resolves.toMatchObject({
      rows: [
        { status: "processing", run_id: claimed!.id },
        { status: "processing", run_id: claimed!.id },
        { status: "pending", run_id: null },
      ],
    });

    await repository.failRun({ runId: claimed!.id, classification: "provider_timeout" });
    await pool!.query("UPDATE conversation_messages SET text = text || ' changed' WHERE id = $1", [
      claimed!.evidenceMessages[0]!.id,
    ]);
    await expect(
      repository.claimRun({
        requestIds: [...coveredRequestIds].reverse(),
        maxEvidenceMessages: 40,
        contextMessageLimit: 0,
        activeMemoryLimit: 0,
      }),
    ).rejects.toBeInstanceOf(MemoryExtractionStaleRunError);
    const reset = await pool!.query<{ id: string; status: string; run_id: string | null }>(
      "SELECT id, status, run_id FROM group_memory_extraction_requests WHERE group_id = $1 ORDER BY created_at, id",
      [groupId],
    );
    expect(reset.rows).toEqual([
      expect.objectContaining({ status: "pending", run_id: null }),
      expect.objectContaining({ status: "pending", run_id: null }),
      expect.objectContaining({ status: "pending", run_id: null }),
    ]);

    const replacement = await repository.claimRun({
      requestIds: coveredRequestIds,
      maxEvidenceMessages: 40,
      contextMessageLimit: 0,
      activeMemoryLimit: 0,
    });
    expect(replacement).toBeDefined();
    expect(replacement!.id).not.toBe(claimed!.id);
    expect(new Set(replacement!.requestIds)).toEqual(new Set(coveredRequestIds));
  });

  it("fails completion stale when an authoritative message changes and inserts no candidate", async () => {
    const repository = createRepository(pool);
    const groupId = `${groupPrefix}-message`;
    const messageId = `feishu:${groupId}`;
    await insertExtractionMessage(pool!, {
      id: messageId,
      groupId,
      text: "Original message",
      createdAt: new Date("2026-07-15T05:00:00.000Z"),
    });
    const registered = await repository.registerRequest({
      groupId,
      conversationMessageId: messageId,
      providerMessageId: `provider-${messageId}`,
    });
    const claimed = await repository.claimRun({
      requestIds: [registered.request.id],
      maxEvidenceMessages: 40,
      contextMessageLimit: 0,
      activeMemoryLimit: 0,
    });
    await pool!.query("UPDATE conversation_messages SET text = 'Changed after model' WHERE id = $1", [
      messageId,
    ]);

    await expect(
      repository.completeRun({
        runId: claimed!.id,
        inputFingerprint: claimed!.inputFingerprint,
        acceptedCandidates: [validatedCandidate({ evidenceMessageIds: [messageId] })],
        diagnostics: diagnostics(),
      }),
    ).rejects.toBeInstanceOf(MemoryExtractionStaleRunError);
    await expectCompletionStaleWithoutMemory(pool!, {
      runId: claimed!.id,
      requestId: registered.request.id,
      idempotencyKey: sha256(claimed!.id + "0"),
    });
  });

  it("fails completion stale when a claimed active memory version changes", async () => {
    const repository = createRepository(pool);
    const groupId = `${groupPrefix}-memory`;
    const messageId = `feishu:${groupId}`;
    const existingMemoryId = `memory-${suffix}`;
    await insertExtractionMessage(pool!, {
      id: messageId,
      groupId,
      text: "Memory freshness message",
      createdAt: new Date("2026-07-15T06:00:00.000Z"),
    });
    await pool!.query(
      `
      INSERT INTO group_memories (
        id, group_id, memory_scope, category, content, importance, confidence,
        status, idempotency_key, origin, created_by, request_fingerprint
      )
      VALUES ($1, $2, 'group', 'decision', 'Current fact', 4, 0.9,
        'active', $3, 'operator', 'test', $4)
      `,
      [existingMemoryId, groupId, `existing-${suffix}`, "a".repeat(64)],
    );
    const registered = await repository.registerRequest({
      groupId,
      conversationMessageId: messageId,
      providerMessageId: `provider-${messageId}`,
    });
    const claimed = await repository.claimRun({
      requestIds: [registered.request.id],
      maxEvidenceMessages: 40,
      contextMessageLimit: 0,
      activeMemoryLimit: 1,
    });
    expect(claimed!.existingMemories.map(({ id }) => id)).toEqual([existingMemoryId]);
    await pool!.query(
      "UPDATE group_memories SET content = 'Changed fact', updated_at = updated_at + interval '1 second' WHERE id = $1",
      [existingMemoryId],
    );

    await expect(
      repository.completeRun({
        runId: claimed!.id,
        inputFingerprint: claimed!.inputFingerprint,
        acceptedCandidates: [validatedCandidate({ evidenceMessageIds: [messageId] })],
        diagnostics: diagnostics(),
      }),
    ).rejects.toBeInstanceOf(MemoryExtractionStaleRunError);
    await expectCompletionStaleWithoutMemory(pool!, {
      runId: claimed!.id,
      requestId: registered.request.id,
      idempotencyKey: sha256(claimed!.id + "0"),
    });
  });
});

async function insertExtractionMessage(
  pool: pg.Pool,
  input: { id: string; groupId: string; text: string; createdAt: Date },
): Promise<void> {
  await pool.query(
    `
    INSERT INTO conversation_messages (
      id, provider, provider_message_id, chat_id, sender_id,
      message_type, text, sent_at, raw_event_idempotency_key, created_at
    )
    VALUES ($1, 'feishu', $2, $3, 'alice', 'text', $4, $5, $6, $5)
    `,
    [
      input.id,
      `provider-${input.id}`,
      input.groupId,
      input.text,
      input.createdAt,
      `event-${input.id}`,
    ],
  );
}

async function expectCompletionStaleWithoutMemory(
  pool: pg.Pool,
  input: { runId: string; requestId: string; idempotencyKey: string },
): Promise<void> {
  await expect(
    pool.query<{ status: string; failure_classification: string }>(
      "SELECT status, failure_classification FROM group_memory_extraction_runs WHERE id = $1",
      [input.runId],
    ),
  ).resolves.toMatchObject({
    rows: [{ status: "failed", failure_classification: "input_stale" }],
  });
  await expect(
    pool.query<{ status: string; run_id: string | null }>(
      "SELECT status, run_id FROM group_memory_extraction_requests WHERE id = $1",
      [input.requestId],
    ),
  ).resolves.toMatchObject({ rows: [{ status: "pending", run_id: null }] });
  await expect(
    pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM group_memories WHERE idempotency_key = $1",
      [input.idempotencyKey],
    ),
  ).resolves.toMatchObject({ rows: [{ count: 0 }] });
}

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
  return { dataSource, sql, query };
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

function requestRouteRow(input: {
  id?: string;
  groupId?: string;
  status?: "pending" | "processing" | "completed" | "skipped";
  runId?: string;
} = {}) {
  return {
    id: input.id ?? "request-1",
    group_id: input.groupId ?? "chat-a",
    status: input.status ?? "pending",
    run_id: input.runId ?? null,
  };
}

function claimMessageRow(input: {
  requestId?: string;
  messageId?: string;
  messageText?: string | null;
  status?: "pending" | "processing";
  runId?: string;
} = {}) {
  const messageId = input.messageId ?? "feishu:message-1";
  return {
    request_id: input.requestId ?? "request-1",
    request_group_id: "chat-a",
    request_provider_message_id: "message-1",
    request_status: input.status ?? "pending",
    request_run_id: input.runId ?? null,
    id: messageId,
    chat_id: "chat-a",
    sender_id: "alice",
    text: input.messageText ?? "Readable seed",
    sent_at: new Date("2026-07-14T00:00:00.000Z"),
    created_at: new Date("2026-07-14T00:00:00.000Z"),
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

function existingRequestRow(input: {
  messageGroupId: string;
  messageProviderId: string;
}) {
  return {
    id: "request-1",
    group_id: "chat-a",
    conversation_message_id: "feishu:message-1",
    provider_message_id: "message-1",
    status: "pending",
    run_id: null,
    skip_reason: null,
    created_at: new Date("2026-07-14T00:00:00.000Z"),
    updated_at: new Date("2026-07-14T00:00:00.000Z"),
    message_group_id: input.messageGroupId,
    message_provider_id: input.messageProviderId,
    message_text: "Readable message",
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

function completionRunRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "run-1",
    group_id: "chat-a",
    input_fingerprint: "f".repeat(64),
    status: "processing",
    failure_classification: null,
    ...overrides,
  };
}

function completionEvidenceRow(requestId: string, messageId: string, ordinal: number) {
  return {
    request_id: requestId,
    conversation_message_id: messageId,
    ordinal,
    request_status: "processing",
    request_run_id: "run-1",
    request_group_id: "chat-a",
    message_group_id: "chat-a",
  };
}

function storedEvidenceRows() {
  return [
    storedEvidenceRow("request-1", "feishu:msg-1", "Launch on Thursday.", 0),
    storedEvidenceRow("request-2", "feishu:msg-2", "Use the release checklist.", 1),
  ];
}

function storedEvidenceRow(requestId: string, id: string, text: string, minute: number) {
  const timestamp = new Date(Date.UTC(2026, 6, 15, 0, minute));
  const message = {
    id,
    groupId: "chat-a",
    senderId: "alice",
    text,
    sentAt: timestamp,
    createdAt: timestamp,
    evidenceEligible: true,
  };
  return {
    request_id: requestId,
    stored_message_id: id,
    stored_content_hash: sha256(JSON.stringify({
      id: message.id,
      groupId: message.groupId,
      senderId: message.senderId,
      text: message.text,
      sentAt: message.sentAt.toISOString(),
      createdAt: message.createdAt.toISOString(),
      evidenceEligible: message.evidenceEligible,
    })),
    id,
    chat_id: message.groupId,
    sender_id: message.senderId,
    text,
    sent_at: timestamp,
    created_at: timestamp,
  };
}

function storedInputFingerprint(rows: ReturnType<typeof storedEvidenceRows>): string {
  return sha256(JSON.stringify({
    groupId: "chat-a",
    evidenceMessages: rows.map((row) => ({
      id: row.id,
      contentHash: row.stored_content_hash,
    })),
    contextMessages: [],
    existingMemories: [],
  }));
}

function validatedCandidate(overrides: Record<string, unknown> = {}) {
  return {
    category: "decision" as const,
    content: "Candidate A.",
    importance: 4,
    confidence: 0.9,
    evidenceMessageIds: ["feishu:msg-1"],
    ...overrides,
  };
}

function diagnostics(overrides: Record<string, unknown> = {}) {
  return {
    proposedCount: 1,
    acceptedCount: 1,
    rejectedCount: 0,
    duplicateCount: 0,
    conflictCount: 0,
    rejectionCodes: [],
    ...overrides,
  };
}

function insertedMemoryRow(params: unknown[]) {
  return {
    id: params[0],
    group_id: params[1],
    memory_scope: params[2],
    category: params[3],
    thread_key: params[4] ?? null,
    content: params[5],
    importance: params[6],
    confidence: params[7],
    status: "active",
    idempotency_key: params[8],
    origin: params[9],
    created_by: params[10],
    supersedes_memory_id: params[11] ?? null,
    request_fingerprint: params[12],
    created_at: new Date("2026-07-15T00:00:00.000Z"),
    updated_at: new Date("2026-07-15T00:00:00.000Z"),
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
