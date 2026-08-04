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
      subjectType: "tool_call",
      subjectId: `tool-${suffix}`,
      eventType: "tool_call_started",
      operationKey: `ledger:${suffix}:tool-start`,
      toolCallId: `tool-${suffix}`,
      toolName: "iris.feishu.searchWiki",
      metadata: { permission: "allowed" },
    }));
    await repository.recordEvent(eventInput("tool-2", {
      subjectType: "tool_call",
      subjectId: `tool-${suffix}`,
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

  it("loads version-bound proactive subjects from the exact group projection", async () => {
    const groupId = `oc_subject_${suffix}`;
    const threadId = `thread-subject-${suffix}`;
    await pool.query(
      `INSERT INTO discussion_threads (
         id, group_id, title, summary, status, confidence, version,
         first_evidence_at, last_activity_at, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, 'open', 0.95, 1, $5, $5, $5, $5)`,
      [threadId, groupId, "Iris PR#22 acceptance discussion", "Bounded integration summary", at],
    );
    const threadCandidate = proactiveCandidate({ groupId, entityId: threadId });
    const threadDeliveryId = await createQueuedProactiveDelivery({
      repository: proactiveRepository,
      candidate: threadCandidate,
    });
    const threadClaim = await proactiveRepository.claimProactiveSignalDelivery({
      workerId: "subject-worker-thread",
      at,
      leaseUntil: new Date(at.getTime() + 30_000),
    });

    expect(threadClaim?.delivery.id).toBe(threadDeliveryId);
    await expect(proactiveRepository.getProactiveSignalDeliveryContext(threadDeliveryId)).resolves.toMatchObject({
      subjectLabel: "Iris PR#22 acceptance discussion",
    });
    await proactiveRepository.completeProactiveSignalDelivery({
      deliveryId: threadDeliveryId,
      workerId: "subject-worker-thread",
      attemptCount: threadClaim!.attempts,
      messageId: `om_thread_${suffix}`,
      at,
    });

    const actionId = `action-subject-${suffix}`;
    await pool.query(
      `INSERT INTO action_items (
         id, group_id, description, owner_ref_type, owner_ref, due_at,
         status, confidence, version, created_at, updated_at
       ) VALUES ($1, $2, $3, 'text_label', 'product owner', $4, 'open', 0.95, 1, $5, $5)`,
      [actionId, groupId, "Complete customer feedback dashboard acceptance", at, at],
    );
    const actionCandidate = proactiveCandidate({
      idempotencyKey: `overdue_action:${actionId}:1`,
      kind: "overdue_action",
      priority: "high",
      groupId,
      entityId: actionId,
      reasonCode: "action_due_at_elapsed",
      suggestedMode: "ask_for_status",
    });
    const actionDeliveryId = await createQueuedProactiveDelivery({
      repository: proactiveRepository,
      candidate: actionCandidate,
    });
    const actionClaim = await proactiveRepository.claimProactiveSignalDelivery({
      workerId: "subject-worker-action",
      at,
      leaseUntil: new Date(at.getTime() + 30_000),
    });

    expect(actionClaim?.delivery.id).toBe(actionDeliveryId);
    await expect(proactiveRepository.getProactiveSignalDeliveryContext(actionDeliveryId)).resolves.toMatchObject({
      subjectLabel: "Complete customer feedback dashboard acceptance",
    });

    await pool.query(
      "UPDATE action_items SET retrieval_state = 'invalidated' WHERE id = $1 AND group_id = $2",
      [actionId, groupId],
    );
    await expect(proactiveRepository.beginProactiveSignalDeliveryAttempt({
      deliveryId: actionDeliveryId,
      workerId: "subject-worker-action",
      attemptCount: actionClaim!.attempts,
      at,
    })).resolves.toEqual({ status: "stale" });
    await expect(proactiveRepository.getProactiveSignalDeliveryContext(actionDeliveryId)).resolves.not.toHaveProperty(
      "subjectLabel",
    );
    await expect(proactiveRepository.claimProactiveSignalDelivery({
      workerId: "subject-worker-action-retry",
      at: new Date(at.getTime() + 1),
      leaseUntil: new Date(at.getTime() + 30_001),
    })).resolves.toBeUndefined();

    const parentThreadId = `thread-parent-${suffix}`;
    await pool.query(
      `INSERT INTO discussion_threads (
         id, group_id, title, summary, status, confidence, version,
         first_evidence_at, last_activity_at, retrieval_state, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, 'open', 0.95, 1, $5, $5, 'invalidated', $5, $5)`,
      [parentThreadId, groupId, "Invalidated parent", "Invalidated parent summary", at],
    );
    const dependentActionId = `action-dependent-${suffix}`;
    await pool.query(
      `INSERT INTO action_items (
         id, group_id, thread_id, description, owner_ref_type, owner_ref, due_at,
         status, confidence, version, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, 'text_label', 'product owner', $5, 'open', 0.95, 1, $6, $6)`,
      [dependentActionId, groupId, parentThreadId, "Do not expose invalid parent action", at, at],
    );
    const dependentCandidate = proactiveCandidate({
      idempotencyKey: `overdue_action:${dependentActionId}:1`,
      kind: "overdue_action",
      priority: "high",
      groupId,
      entityId: dependentActionId,
      reasonCode: "action_due_at_elapsed",
      suggestedMode: "ask_for_status",
    });
    const dependentDeliveryId = await createQueuedProactiveDelivery({
      repository: proactiveRepository,
      candidate: dependentCandidate,
    });
    const dependentClaim = await proactiveRepository.claimProactiveSignalDelivery({
      workerId: "subject-worker-dependent",
      at,
      leaseUntil: new Date(at.getTime() + 30_000),
    });

    expect(dependentClaim?.delivery.id).toBe(dependentDeliveryId);
    await expect(proactiveRepository.getProactiveSignalDeliveryContext(dependentDeliveryId)).resolves.not.toHaveProperty(
      "subjectLabel",
    );
    await proactiveRepository.failProactiveSignalDeliveryPreparation({
      deliveryId: dependentDeliveryId,
      workerId: "subject-worker-dependent",
      attemptCount: dependentClaim!.attempts,
      errorCode: "stale_delivery",
      at,
    });
    await expect(proactiveRepository.claimProactiveSignalDelivery({
      workerId: "subject-worker-dependent-retry",
      at: new Date(at.getTime() + 1),
      leaseUntil: new Date(at.getTime() + 30_001),
    })).resolves.toBeUndefined();
  });

  it("fences stale delivery attempts when a fixed worker id reclaims an expired lease", async () => {
    const groupId = `oc_delivery_fence_${suffix}`;
    const threadId = `thread-delivery-fence-${suffix}`;
    await pool.query(
      `INSERT INTO discussion_threads (
         id, group_id, title, summary, status, confidence, version,
         first_evidence_at, last_activity_at, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, 'open', 0.95, 1, $5, $5, $5, $5)`,
      [threadId, groupId, "Fenced proactive delivery", "Fencing integration summary", at],
    );
    const deliveryId = await createQueuedProactiveDelivery({
      repository: proactiveRepository,
      candidate: proactiveCandidate({ groupId, entityId: threadId }),
    });
    const workerId = "shared-proactive-worker";
    const firstClaimAt = new Date(at.getTime() + 1_000);
    const firstClaim = await proactiveRepository.claimProactiveSignalDelivery({
      workerId,
      at: firstClaimAt,
      leaseUntil: new Date(firstClaimAt.getTime() + 10),
    });
    const secondClaimAt = new Date(firstClaimAt.getTime() + 20);
    const secondClaim = await proactiveRepository.claimProactiveSignalDelivery({
      workerId,
      at: secondClaimAt,
      leaseUntil: new Date(secondClaimAt.getTime() + 30_000),
    });

    expect(firstClaim).toMatchObject({ delivery: { id: deliveryId, attemptCount: 1 }, attempts: 1 });
    expect(secondClaim).toMatchObject({ delivery: { id: deliveryId, attemptCount: 2 }, attempts: 2 });
    await expect(proactiveRepository.beginProactiveSignalDeliveryAttempt({
      deliveryId,
      workerId,
      attemptCount: 1,
      at: secondClaimAt,
    })).resolves.toEqual({ status: "stale" });
    await expect(proactiveRepository.failProactiveSignalDeliveryPreparation({
      deliveryId,
      workerId,
      attemptCount: 1,
      errorCode: "stale_delivery",
      at: secondClaimAt,
    })).rejects.toThrow("delivery attempt is stale");
    await expect(proactiveRepository.completeProactiveSignalDelivery({
      deliveryId,
      workerId,
      attemptCount: 1,
      messageId: "om_stale_attempt",
      at: secondClaimAt,
    })).rejects.toThrow("delivery attempt is stale");
    await expect(proactiveRepository.getProactiveSignalDeliveryContext(deliveryId)).resolves.toMatchObject({
      delivery: { status: "processing", attemptCount: 2 },
      subjectLabel: "Fenced proactive delivery",
    });

    await expect(proactiveRepository.failProactiveSignalDeliveryPreparation({
      deliveryId,
      workerId,
      attemptCount: 2,
      errorCode: "runtime_disabled",
      at: secondClaimAt,
    })).resolves.toBeUndefined();
    await expect(proactiveRepository.getProactiveSignalDeliveryContext(deliveryId)).resolves.toMatchObject({
      delivery: { status: "cancelled", attemptCount: 2 },
    });
  });

  it("records feedback only once for an exact sent delivery binding", async () => {
    const groupId = `oc_feedback_${suffix}`;
    const candidate = proactiveCandidate({ groupId, entityId: `thread-feedback-${suffix}`, entityVersion: 2 });
    const deliveryId = await createSentProactiveDelivery({ repository: proactiveRepository, pool, candidate });
    const input = proactiveFeedback({
      groupId,
      deliveryId,
      candidateIdempotencyKey: candidate.idempotencyKey,
      entityVersion: candidate.entityVersion,
    });

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
    await pool.query(
      "UPDATE proactive_signal_delivery_outbox SET status = 'cancelled' WHERE id = $1",
      [unsentDeliveryId],
    );
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
    const secondCandidate = proactiveCandidate({ groupId, entityId, entityVersion: 2 });
    const secondDeliveryId = await createSentProactiveDelivery({
      repository: proactiveRepository,
      pool,
      candidate: secondCandidate,
    });
    const queuedBeforeSuppression = proactiveCandidate({ groupId, entityId, entityVersion: 3 });
    await createQueuedProactiveDelivery({
      repository: proactiveRepository,
      candidate: queuedBeforeSuppression,
    });
    const pendingBeforeSuppression = proactiveCandidate({ groupId, entityId, entityVersion: 4 });
    await proactiveRepository.recordCandidates({ signals: [pendingBeforeSuppression], now: at });

    const firstFeedback = proactiveFeedback({
      idempotencyKey: `feishu-card:${suffix}:suppression-first`,
      groupId,
      deliveryId: firstDeliveryId,
      candidateIdempotencyKey: firstCandidate.idempotencyKey,
      entityVersion: firstCandidate.entityVersion,
      suppressUntil: new Date("2026-08-26T00:00:00.000Z"),
    });
    const bindings = await pool.query(
      `SELECT delivery.id, delivery.candidate_idempotency_key, delivery.group_id,
        delivery.status, delivery.sent_message_id, candidate.entity_version
       FROM proactive_signal_delivery_outbox delivery
       JOIN proactive_signal_candidates candidate
         ON candidate.idempotency_key = delivery.candidate_idempotency_key
        AND candidate.group_id = delivery.group_id
       WHERE delivery.id = ANY($1::text[])
       ORDER BY candidate.entity_version`,
      [[firstDeliveryId, secondDeliveryId]],
    );
    expect(bindings.rows).toEqual([
      {
        id: firstDeliveryId,
        candidate_idempotency_key: firstCandidate.idempotencyKey,
        group_id: groupId,
        status: "sent",
        sent_message_id: "om_card",
        entity_version: "1",
      },
      {
        id: secondDeliveryId,
        candidate_idempotency_key: secondCandidate.idempotencyKey,
        group_id: groupId,
        status: "sent",
        sent_message_id: "om_card",
        entity_version: "2",
      },
    ]);
    await expect(proactiveRepository.validateFeedbackBinding({
      deliveryId: firstFeedback.deliveryId,
      candidateIdempotencyKey: firstFeedback.candidateIdempotencyKey,
      groupId: firstFeedback.groupId,
      messageId: firstFeedback.messageId,
      entityVersion: firstFeedback.entityVersion,
    })).resolves.toEqual({ status: "valid" });
    await expect(proactiveRepository.recordFeedback(firstFeedback)).resolves.toEqual({ status: "applied" });

    await expect(proactiveRepository.recordFeedback(proactiveFeedback({
      idempotencyKey: `feishu-card:${suffix}:second`,
      groupId,
      deliveryId: secondDeliveryId,
      candidateIdempotencyKey: secondCandidate.idempotencyKey,
      entityVersion: secondCandidate.entityVersion,
      actorFingerprint: "c".repeat(64),
      suppressUntil: new Date("2026-08-27T00:00:00.000Z"),
    }))).resolves.toEqual({ status: "applied" });

    await expect(proactiveRepository.claimProactiveSignalDelivery({
      workerId: `worker-${suffix}`,
      at: new Date("2026-07-27T01:00:00.000Z"),
      leaseUntil: new Date("2026-07-27T01:01:00.000Z"),
    })).resolves.toBeUndefined();
    await expect(proactiveRepository.approveCandidateForDelivery({
      idempotencyKey: pendingBeforeSuppression.idempotencyKey,
      groupId,
      operatorHint: "integration-test",
      now: new Date("2026-07-27T01:00:00.000Z"),
    })).resolves.toEqual({ status: "not_found" });

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
      entityVersion: helpfulCandidate.entityVersion,
      actorFingerprint: "d".repeat(64),
      feedback: "helpful",
    }))).resolves.toEqual({ status: "applied" });

    const suppressions = await pool.query(
      `SELECT suppression.entity_id, suppression.suppress_until,
        suppression.source_feedback_event_id, feedback.feedback
       FROM proactive_signal_suppressions suppression
       JOIN proactive_signal_feedback_events feedback
         ON feedback.idempotency_key = suppression.source_feedback_event_id
       WHERE suppression.group_id = $1
       ORDER BY suppression.entity_id`,
      [groupId],
    );
    expect(suppressions.rows).toEqual([{
      entity_id: entityId,
      suppress_until: new Date("2026-08-27T00:00:00.000Z"),
      source_feedback_event_id: `feishu-card:${suffix}:second`,
      feedback: "irrelevant",
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

    const suppressedCandidate = proactiveCandidate({ groupId, entityId, entityVersion: 5 });
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
    const expiredCandidate = proactiveCandidate({ groupId, entityId, entityVersion: 6 });
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

  it("cancels a claimed delivery when irrelevant feedback commits before final authorization", async () => {
    const groupId = `oc_claimed_suppression_${suffix}`;
    const entityId = `thread-claimed-suppression-${suffix}`;
    const sentCandidate = proactiveCandidate({ groupId, entityId, entityVersion: 1 });
    const sentDeliveryId = await createSentProactiveDelivery({
      repository: proactiveRepository,
      pool,
      candidate: sentCandidate,
    });
    const claimedCandidate = proactiveCandidate({ groupId, entityId, entityVersion: 2 });
    const claimedDeliveryId = await createQueuedProactiveDelivery({
      repository: proactiveRepository,
      candidate: claimedCandidate,
    });
    const workerId = `worker-claimed-${suffix}`;
    const claimAt = new Date(at.getTime() + 60_000);

    const claimed = await pool.query(
      `UPDATE proactive_signal_delivery_outbox
       SET status = 'processing',
           lease_worker_id = $2,
           lease_until = $3,
           attempt_count = attempt_count + 1,
           updated_at = $4
       WHERE id = $1
         AND status = 'pending'
       RETURNING id`,
      [claimedDeliveryId, workerId, new Date(claimAt.getTime() + 60_000), claimAt],
    );
    expect(claimed.rows).toEqual([{ id: claimedDeliveryId }]);

    const feedbackAt = new Date(at.getTime() + 90_000);
    await expect(proactiveRepository.recordFeedback(proactiveFeedback({
      idempotencyKey: `feishu-card:${suffix}:claimed-suppression`,
      groupId,
      deliveryId: sentDeliveryId,
      candidateIdempotencyKey: sentCandidate.idempotencyKey,
      entityVersion: sentCandidate.entityVersion,
      suppressUntil: new Date(feedbackAt.getTime() + 30 * 24 * 60 * 60 * 1000),
      at: feedbackAt,
    }))).resolves.toEqual({ status: "applied" });

    const authorizationAt = new Date(at.getTime() + 100_000);
    await expect(proactiveRepository.beginProactiveSignalDeliveryAttempt({
      deliveryId: claimedDeliveryId,
      workerId,
      attemptCount: 1,
      at: authorizationAt,
    })).resolves.toEqual({ status: "suppressed" });

    const delivery = await pool.query(
      `SELECT status, lease_worker_id, lease_until, failure_classification
       FROM proactive_signal_delivery_outbox
       WHERE id = $1`,
      [claimedDeliveryId],
    );
    expect(delivery.rows).toEqual([{
      status: "cancelled",
      lease_worker_id: null,
      lease_until: null,
      failure_classification: "feedback_suppressed",
    }]);
    await expect(proactiveRepository.beginProactiveSignalDeliveryAttempt({
      deliveryId: claimedDeliveryId,
      workerId,
      attemptCount: 1,
      at: new Date(authorizationAt.getTime() + 60_000),
    })).resolves.toEqual({ status: "stale" });
  });

  it("rejects final delivery authorization after the worker lease expires", async () => {
    const groupId = `oc_expired_lease_${suffix}`;
    const candidate = proactiveCandidate({
      groupId,
      entityId: `thread-expired-lease-${suffix}`,
      entityVersion: 1,
    });
    const deliveryId = await createQueuedProactiveDelivery({
      repository: proactiveRepository,
      candidate,
    });
    const workerId = `worker-expired-${suffix}`;
    const leaseUntil = new Date(at.getTime() + 60_000);
    await pool.query(
      `UPDATE proactive_signal_delivery_outbox
       SET status = 'processing',
           lease_worker_id = $2,
           lease_until = $3,
           attempt_count = attempt_count + 1,
           updated_at = $3
       WHERE id = $1`,
      [deliveryId, workerId, leaseUntil],
    );

    await expect(proactiveRepository.beginProactiveSignalDeliveryAttempt({
      deliveryId,
      workerId,
      attemptCount: 1,
      at: new Date(leaseUntil.getTime() + 1),
    })).resolves.toEqual({ status: "stale" });

    const processingEvents = await pool.query(
      `SELECT COUNT(*)::integer AS count
       FROM proactive_signal_delivery_events
       WHERE delivery_id = $1
         AND event_type = 'processing'`,
      [deliveryId],
    );
    expect(processingEvents.rows).toEqual([{ count: 0 }]);
  });

  it("serializes feedback suppression ahead of a concurrent candidate insertion", async () => {
    const groupId = `oc_feedback_race_${suffix}`;
    const entityId = `thread-feedback-race-${suffix}`;
    const sentCandidate = proactiveCandidate({ groupId, entityId, entityVersion: 1 });
    const deliveryId = await createSentProactiveDelivery({
      repository: proactiveRepository,
      pool,
      candidate: sentCandidate,
    });
    const concurrentCandidate = proactiveCandidate({ groupId, entityId, entityVersion: 2 });
    const blocker = await pool.connect();
    await blocker.query("BEGIN");
    await blocker.query(
      `SELECT id
       FROM proactive_signal_delivery_outbox
       WHERE id = $1
       FOR UPDATE`,
      [deliveryId],
    );

    let feedbackPromise: Promise<{ status: "applied" | "already_applied" | "stale_binding" }>;
    let candidatePromise: ReturnType<ProactiveSignalRepository["recordCandidates"]>;
    let candidateWaitedForGroupLock: boolean;
    try {
      feedbackPromise = proactiveRepository.recordFeedback(proactiveFeedback({
        idempotencyKey: `feishu-card:${suffix}:feedback-race`,
        groupId,
        deliveryId,
        candidateIdempotencyKey: sentCandidate.idempotencyKey,
        entityVersion: sentCandidate.entityVersion,
        suppressUntil: new Date(at.getTime() + 30 * 24 * 60 * 60 * 1000),
      }));
      await waitForBlockedDatabaseQuery(pool, "%for key share of delivery%");

      let candidateSettled = false;
      candidatePromise = proactiveRepository.recordCandidates({
        signals: [concurrentCandidate],
        now: at,
      }).finally(() => {
        candidateSettled = true;
      });
      candidateWaitedForGroupLock = await waitForAdvisoryLockOrSettlement(
        pool,
        () => candidateSettled,
      );
    } finally {
      await blocker.query("COMMIT");
      blocker.release();
    }
    const [feedbackResult, candidateResult] = await Promise.all([
      feedbackPromise!,
      candidatePromise!,
    ]);

    expect(candidateWaitedForGroupLock!).toBe(true);
    expect(feedbackResult).toEqual({ status: "applied" });
    expect(candidateResult).toEqual({
      recordedCount: 0,
      existingCount: 0,
      suppressedCount: 1,
      recordedKeys: [],
    });
  }, 15_000);
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
    entityVersion: 1,
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

async function waitForBlockedDatabaseQuery(
  pool: pg.Pool,
  queryPattern: string,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await pool.query(
      `SELECT EXISTS (
         SELECT 1
         FROM pg_stat_activity
         WHERE datname = current_database()
           AND pid <> pg_backend_pid()
           AND wait_event_type = 'Lock'
           AND query ILIKE $1
       ) AS waiting`,
      [queryPattern],
    );
    if (result.rows[0]?.waiting === true) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for blocked query ${queryPattern}`);
}

async function waitForAdvisoryLockOrSettlement(
  pool: pg.Pool,
  isSettled: () => boolean,
): Promise<boolean> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (isSettled()) return false;
    const result = await pool.query(
      `SELECT EXISTS (
         SELECT 1
         FROM pg_stat_activity
         WHERE datname = current_database()
           AND pid <> pg_backend_pid()
           AND wait_event_type = 'Lock'
           AND query ILIKE '%pg_advisory_xact_lock%'
       ) AS waiting`,
    );
    if (result.rows[0]?.waiting === true) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for proactive group advisory lock");
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
