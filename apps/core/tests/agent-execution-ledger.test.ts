import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createPostgresAgentExecutionLedgerRepository,
  AgentExecutionLedgerOperationConflictError,
  type AgentExecutionLedgerRepository,
} from "../src/agent-runtime/agent-execution-ledger-repository.js";
import {
  defaultMigrationsDir,
  runMigrations,
  type MigrationClient,
} from "../src/database/migrate.js";
import type {
  PostgresKnowledgeDraftDataSource,
} from "../src/knowledge-governance/postgres-knowledge-draft-repository.js";
import {
  createPostgresProactiveSignalRepository,
  type ProactiveSignalDataSource,
  type ProactiveSignalRepository,
} from "../src/proactive-signals/proactive-signal-repository.js";
import type { ProactiveSignalCandidate } from "../src/proactive-signals/proactive-signal-planner.js";

const databaseUrl = process.env.IRIS_TEST_DATABASE_URL?.trim();
const runIfDatabase = databaseUrl ? describe.sequential : describe.skip;
const suffix = randomUUID();
const schema = `agent_ledger_${suffix.replaceAll("-", "")}`;
const at = new Date("2026-07-27T10:00:00.000Z");

describe("agent execution ledger migration contract", () => {
  const migration = readFileSync(
    new URL("../migrations/0039_agent_execution_ledger.sql", import.meta.url),
    "utf8",
  );

  it("defines a content-free append-only agent execution event ledger", () => {
    const normalized = migration.replace(/\s+/g, " ").trim().toLowerCase();

    expect(normalized).toContain("create table agent_execution_ledger_events");
    expect(normalized).toContain("operation_key text not null unique");
    expect(normalized).toContain("operation_fingerprint text not null");
    expect(normalized).toContain("metadata jsonb not null default '{}'::jsonb");
    expect(normalized).toContain("content_fingerprint text");
    expect(normalized).not.toContain("raw_content");
    expect(normalized).not.toContain("prompt_context");
    expect(normalized).toContain("agent_execution_ledger_events_append_only");
    expect(normalized).toContain("agent_execution_ledger_events_group_time_idx");
    expect(normalized).toContain("agent_execution_ledger_events_subject_time_idx");
    expect(normalized).toContain("agent_execution_ledger_events_tool_call_idx");
  });

  it("is included before proactive feedback migrations", async () => {
    const migrationNames = (await import("node:fs/promises"))
      .readdir(defaultMigrationsDir())
      .then((names) => names.sort((left, right) => left.localeCompare(right)));

    expect(await migrationNames).toEqual(
      expect.arrayContaining([
        "0038_proactive_signal_delivery_outbox.sql",
        "0039_agent_execution_ledger.sql",
        "0040_proactive_signal_feedback.sql",
      ]),
    );
  });
});

describe("PostgresAgentExecutionLedgerRepository replay semantics", () => {
  it("treats row identity, observation time, and metadata key order as non-semantic", async () => {
    const repository = createPostgresAgentExecutionLedgerRepository({
      dataSource: createReplayDataSource(),
    });
    const original = eventInput("semantic-replay", {
      operationKey: `ledger:${suffix}:semantic-replay`,
      metadata: { route: "mention", attempt: 1 },
    });

    await expect(repository.recordEvent(original)).resolves.toMatchObject({
      outcome: "applied",
      event: { id: original.id },
    });
    await expect(repository.recordEvent({
      ...original,
      id: `semantic-replay-retry-${suffix}`,
      at: new Date("2026-07-27T10:05:00.000Z"),
      metadata: { attempt: 1, route: "mention" },
    })).resolves.toMatchObject({
      outcome: "already_applied",
      event: {
        id: original.id,
        createdAt: original.at,
      },
    });
  });

  it("rejects replay when semantic outcome changes", async () => {
    const repository = createPostgresAgentExecutionLedgerRepository({
      dataSource: createReplayDataSource(),
    });
    const original = eventInput("semantic-conflict", {
      operationKey: `ledger:${suffix}:semantic-conflict`,
      outcome: "success",
    });

    await repository.recordEvent(original);

    await expect(repository.recordEvent({
      ...original,
      id: `semantic-conflict-retry-${suffix}`,
      at: new Date("2026-07-27T10:05:00.000Z"),
      outcome: "error",
    })).rejects.toBeInstanceOf(AgentExecutionLedgerOperationConflictError);
  });
});

runIfDatabase("PostgresAgentExecutionLedgerRepository with Postgres", () => {
  let adminPool: pg.Pool;
  let pool: pg.Pool;
  let repository: AgentExecutionLedgerRepository;
  let proactiveRepository: ProactiveSignalRepository;

  beforeAll(async () => {
    adminPool = new pg.Pool({ connectionString: databaseUrl });
    await adminPool.query(`CREATE SCHEMA ${schema}`);
    const isolatedUrl = new URL(databaseUrl!);
    isolatedUrl.searchParams.set("options", `-c search_path=${schema},public`);
    pool = new pg.Pool({ connectionString: isolatedUrl.toString() });
    await runMigrations({
      client: pool as unknown as MigrationClient,
      migrationsDir: defaultMigrationsDir(),
    });
    repository = createPostgresAgentExecutionLedgerRepository({
      dataSource: pool as unknown as PostgresKnowledgeDraftDataSource,
    });
    proactiveRepository = createPostgresProactiveSignalRepository({
      dataSource: pool as unknown as ProactiveSignalDataSource,
    });
  });

  afterAll(async () => {
    await pool?.end();
    await adminPool?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await adminPool?.end();
  });

  it("records exact replay once and rejects conflicting replay", async () => {
    const input = eventInput("turn-1", {
      operationKey: `ledger:${suffix}:turn`,
      metadata: { status: "sampled", count: 1 },
    });

    await expect(repository.recordEvent(input)).resolves.toMatchObject({
      outcome: "applied",
      event: {
        id: input.id,
        eventType: "turn_started",
        operationKey: input.operationKey,
        metadata: { status: "sampled", count: 1 },
      },
    });
    await expect(repository.recordEvent(input)).resolves.toMatchObject({
      outcome: "already_applied",
      event: { id: input.id },
    });
    await expect(repository.recordEvent({
      ...input,
      metadata: { status: "changed" },
    })).rejects.toBeInstanceOf(AgentExecutionLedgerOperationConflictError);
  });

  it("lists bounded events without sensitive content fields", async () => {
    await repository.recordEvent(eventInput("tool-1", {
      eventType: "tool_call_started",
      operationKey: `ledger:${suffix}:tool-start`,
      toolCallId: `tool-${suffix}`,
      toolName: "iris.feishu.searchWiki",
      metadata: { permission: "allowed" },
    }));
    await repository.recordEvent(eventInput("tool-2", {
      eventType: "tool_call_completed",
      operationKey: `ledger:${suffix}:tool-complete`,
      toolCallId: `tool-${suffix}`,
      toolName: "iris.feishu.searchWiki",
      metadata: { result: "ok" },
    }));

    const events = await repository.listEvents({
      groupId: `oc_${suffix}`,
      subjectType: "tool_call",
      subjectId: `tool-${suffix}`,
      limit: 10,
    });

    expect(events).toHaveLength(2);
    expect(JSON.stringify(events)).not.toMatch(/secret|prompt|rawContent|promptContext/u);
    expect(events.map((event) => event.eventType)).toEqual([
      "tool_call_started",
      "tool_call_completed",
    ]);
  });

  it("records feedback only once for an exact sent delivery binding", async () => {
    const groupId = `oc_feedback_${suffix}`;
    const candidate = proactiveCandidate({ groupId, entityId: `thread-feedback-${suffix}`, entityVersion: 2 });
    const deliveryId = await createSentProactiveDelivery({ repository: proactiveRepository, pool, candidate });
    const input = proactiveFeedback({ groupId, deliveryId, candidateIdempotencyKey: candidate.idempotencyKey });

    await expect(proactiveRepository.recordFeedback(input)).resolves.toEqual({ status: "applied" });
    await expect(proactiveRepository.recordFeedback(input)).resolves.toEqual({ status: "already_applied" });
    await expect(proactiveRepository.recordFeedback({
      ...input,
      idempotencyKey: `${input.idempotencyKey}:replay`,
    })).resolves.toEqual({ status: "already_applied" });

    await expect(proactiveRepository.recordFeedback({ ...input, groupId: "oc_wrong" })).resolves.toEqual({
      status: "stale_binding",
    });
    await expect(proactiveRepository.recordFeedback({ ...input, deliveryId: "delivery-missing" })).resolves.toEqual({
      status: "stale_binding",
    });
    await expect(proactiveRepository.recordFeedback({
      ...input,
      candidateIdempotencyKey: "quiet_open_thread:thread-wrong:2",
    })).resolves.toEqual({ status: "stale_binding" });
    await expect(proactiveRepository.recordFeedback({ ...input, messageId: "om_wrong" })).resolves.toEqual({
      status: "stale_binding",
    });
    await expect(proactiveRepository.recordFeedback({ ...input, entityVersion: 3 })).resolves.toEqual({
      status: "stale_binding",
    });

    const unsentCandidate = proactiveCandidate({
      groupId,
      entityId: `thread-unsent-${suffix}`,
      entityVersion: 1,
    });
    const unsentDeliveryId = await createQueuedProactiveDelivery({
      repository: proactiveRepository,
      candidate: unsentCandidate,
    });
    await expect(proactiveRepository.recordFeedback(proactiveFeedback({
      groupId,
      deliveryId: unsentDeliveryId,
      candidateIdempotencyKey: unsentCandidate.idempotencyKey,
      actorFingerprint: "b".repeat(64),
    }))).resolves.toEqual({ status: "stale_binding" });
  });

  it("projects irrelevant feedback into one active suppression and expires it at insertion time", async () => {
    const groupId = `oc_suppression_${suffix}`;
    const entityId = `thread-suppression-${suffix}`;
    const firstCandidate = proactiveCandidate({ groupId, entityId, entityVersion: 1 });
    const firstDeliveryId = await createSentProactiveDelivery({
      repository: proactiveRepository,
      pool,
      candidate: firstCandidate,
    });
    const firstFeedback = proactiveFeedback({
      groupId,
      deliveryId: firstDeliveryId,
      candidateIdempotencyKey: firstCandidate.idempotencyKey,
      suppressUntil: new Date("2026-08-26T00:00:00.000Z"),
    });
    await expect(proactiveRepository.recordFeedback(firstFeedback)).resolves.toEqual({ status: "applied" });

    const secondCandidate = proactiveCandidate({ groupId, entityId, entityVersion: 2 });
    const secondDeliveryId = await createSentProactiveDelivery({
      repository: proactiveRepository,
      pool,
      candidate: secondCandidate,
    });
    await expect(proactiveRepository.recordFeedback(proactiveFeedback({
      idempotencyKey: `feishu-card:${suffix}:second`,
      groupId,
      deliveryId: secondDeliveryId,
      candidateIdempotencyKey: secondCandidate.idempotencyKey,
      actorFingerprint: "c".repeat(64),
      suppressUntil: new Date("2026-08-27T00:00:00.000Z"),
    }))).resolves.toEqual({ status: "applied" });

    const helpfulCandidate = proactiveCandidate({
      groupId,
      entityId: `thread-helpful-${suffix}`,
      entityVersion: 1,
    });
    const helpfulDeliveryId = await createSentProactiveDelivery({
      repository: proactiveRepository,
      pool,
      candidate: helpfulCandidate,
    });
    await expect(proactiveRepository.recordFeedback(proactiveFeedback({
      idempotencyKey: `feishu-card:${suffix}:helpful`,
      groupId,
      deliveryId: helpfulDeliveryId,
      candidateIdempotencyKey: helpfulCandidate.idempotencyKey,
      actorFingerprint: "d".repeat(64),
      feedback: "helpful",
    }))).resolves.toEqual({ status: "applied" });

    const suppressions = await pool.query(
      "SELECT entity_id, suppress_until FROM proactive_signal_suppressions WHERE group_id = $1 ORDER BY entity_id",
      [groupId],
    );
    expect(suppressions.rows).toEqual([{
      entity_id: entityId,
      suppress_until: new Date("2026-08-27T00:00:00.000Z"),
    }]);

    const summary = await proactiveRepository.getFeedbackSummary({
      groupId,
      at: new Date("2026-07-27T01:00:00.000Z"),
    });
    expect(summary).toEqual({
      groupId,
      totalCount: 3,
      helpfulCount: 1,
      irrelevantCount: 2,
      helpfulRate: 1 / 3,
      activeSuppressionCount: 1,
      lastFeedbackAt: new Date("2026-07-27T00:00:00.000Z"),
    });
    expect(JSON.stringify(summary)).not.toContain("actorFingerprint");

    const suppressedCandidate = proactiveCandidate({ groupId, entityId, entityVersion: 3 });
    await expect(proactiveRepository.recordCandidates({
      signals: [suppressedCandidate],
      now: new Date("2026-07-27T01:00:00.000Z"),
    })).resolves.toEqual({
      recordedCount: 0,
      existingCount: 0,
      suppressedCount: 1,
      recordedKeys: [],
    });

    await pool.query(
      "UPDATE proactive_signal_suppressions SET suppress_until = $2 WHERE group_id = $1",
      [groupId, new Date("2026-07-27T00:30:00.000Z")],
    );
    const expiredCandidate = proactiveCandidate({ groupId, entityId, entityVersion: 4 });
    await expect(proactiveRepository.recordCandidates({
      signals: [expiredCandidate],
      now: new Date("2026-07-27T01:00:00.000Z"),
    })).resolves.toEqual({
      recordedCount: 1,
      existingCount: 0,
      suppressedCount: 0,
      recordedKeys: [expiredCandidate.idempotencyKey],
    });
  });
});

function proactiveCandidate(overrides: Partial<ProactiveSignalCandidate> = {}): ProactiveSignalCandidate {
  const groupId = `oc_${suffix}`;
  const entityId = `thread-${suffix}`;
  const entityVersion = 1;
  return {
    idempotencyKey: overrides.idempotencyKey
      ?? `quiet_open_thread:${overrides.entityId ?? entityId}:${overrides.entityVersion ?? entityVersion}`,
    kind: "quiet_open_thread",
    priority: "medium",
    groupId,
    entityId,
    entityVersion,
    reasonCode: "thread_quiet_threshold_elapsed",
    suggestedMode: "ask_for_thread_update",
    lastRelevantAt: at,
    evidenceMessageIds: [],
    ...overrides,
  };
}

function proactiveFeedback(
  overrides: Partial<Parameters<ProactiveSignalRepository["recordFeedback"]>[0]> = {},
): Parameters<ProactiveSignalRepository["recordFeedback"]>[0] {
  return {
    idempotencyKey: `feishu-card:${suffix}:event-1`,
    deliveryId: "delivery-missing",
    candidateIdempotencyKey: "quiet_open_thread:thread-missing:1",
    groupId: `oc_${suffix}`,
    messageId: "om_card",
    entityVersion: 2,
    actorFingerprint: "a".repeat(64),
    feedback: "irrelevant",
    suppressUntil: new Date("2026-08-26T00:00:00.000Z"),
    at: new Date("2026-07-27T00:00:00.000Z"),
    ...overrides,
  };
}

async function createQueuedProactiveDelivery({
  repository,
  candidate,
}: {
  repository: ProactiveSignalRepository;
  candidate: ProactiveSignalCandidate;
}): Promise<string> {
  await repository.recordCandidates({ signals: [candidate], now: at });
  const result = await repository.approveCandidateForDelivery({
    idempotencyKey: candidate.idempotencyKey,
    groupId: candidate.groupId,
    operatorHint: "integration-test",
    now: at,
  });
  if (result.status !== "queued") throw new Error("expected a queued proactive delivery");
  return result.deliveryId;
}

async function createSentProactiveDelivery({
  repository,
  pool,
  candidate,
}: {
  repository: ProactiveSignalRepository;
  pool: pg.Pool;
  candidate: ProactiveSignalCandidate;
}): Promise<string> {
  const deliveryId = await createQueuedProactiveDelivery({ repository, candidate });
  await pool.query(
    "UPDATE proactive_signal_delivery_outbox SET status = 'sent', sent_message_id = $2 WHERE id = $1",
    [deliveryId, "om_card"],
  );
  return deliveryId;
}

function eventInput(
  id: string,
  overrides: Partial<Parameters<AgentExecutionLedgerRepository["recordEvent"]>[0]> = {},
) {
  return {
    id: `${id}-${suffix}`,
    tenantKey: "default",
    groupId: `oc_${suffix}`,
    subjectType: "turn" as const,
    subjectId: `turn-${suffix}`,
    eventType: "turn_started" as const,
    operationKey: `ledger:${suffix}:${id}`,
    metadata: {},
    at,
    ...overrides,
  };
}

function createReplayDataSource(): PostgresKnowledgeDraftDataSource {
  let storedRow: Record<string, unknown> | undefined;
  const query = async (sql: string, values: unknown[] = []) => {
    const normalized = sql.replace(/\s+/gu, " ").trim().toLowerCase();
    if (normalized.startsWith("select * from agent_execution_ledger_events")) {
      return { rows: storedRow === undefined ? [] : [storedRow] };
    }
    if (normalized.startsWith("insert into agent_execution_ledger_events")) {
      storedRow = {
        id: values[0],
        tenant_key: values[1],
        group_id: values[2],
        actor_open_id: values[3],
        subject_type: values[4],
        subject_id: values[5],
        event_type: values[6],
        phase: values[7],
        tool_call_id: values[8],
        tool_name: values[9],
        model_id: values[10],
        provider: values[11],
        outcome: values[12],
        decision_reason: values[13],
        operation_key: values[14],
        operation_fingerprint: values[15],
        metadata: JSON.parse(String(values[16])) as Record<string, unknown>,
        content_fingerprint: values[17],
        duration_ms: values[18],
        created_at: values[19],
      };
      return { rows: [storedRow] };
    }
    return { rows: [] };
  };
  const client = {
    query,
    release() {},
  };
  return {
    query,
    async connect() {
      return client;
    },
  } as unknown as PostgresKnowledgeDraftDataSource;
}
