import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  defaultMigrationsDir,
  runMigrations,
  type MigrationClient,
} from "../src/database/migrate.js";
import { createPostgresActionProposalRepository } from
  "../src/action-approvals/postgres-action-proposal-repository.js";
import { createPostgresFormalTaskCardRepository } from
  "../src/formal-tasks/postgres-formal-task-card-repository.js";
import {
  FormalTaskExecutionPersistenceConflictError,
  createPostgresFormalTaskExecutionRepository,
} from "../src/formal-tasks/postgres-formal-task-execution-repository.js";
import { createPostgresFormalTaskRepository } from
  "../src/formal-tasks/postgres-formal-task-repository.js";

const databaseUrl = process.env.IRIS_TEST_DATABASE_URL?.trim();
const runIfDatabase = databaseUrl ? describe : describe.skip;
const at = new Date("2026-08-22T12:00:00.000Z");

runIfDatabase("PostgresFormalTaskExecutionRepository with Postgres", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl });
    await runMigrations({
      client: pool as unknown as MigrationClient,
      migrationsDir: defaultMigrationsDir(),
    });
    await cleanupOwnedOutboxes(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  it("claims an exact approved task, commits dispatch, and atomically records success plus result outbox", async () => {
    const seeded = await seedApprovedTask(pool, "success");
    const repository = createPostgresFormalTaskExecutionRepository({ dataSource: pool });
    const claim = await repository.claimNextCreation({
      runtimeGate: runtimeGate(seeded.groupId),
      workerId: "task-executor-success",
      leaseUntil: plusSeconds(30),
      operationKey: `task-execution-claim:success:${seeded.suffix}`,
      at,
    });

    expect(claim).toMatchObject({
      proposal: { id: seeded.proposalId, version: 4 },
      approvalId: seeded.approvalId,
      execution: {
        state: "claimed",
        attemptNumber: 1,
        version: 1,
        workerId: "task-executor-success",
      },
      draft: {
        id: seeded.draftId,
        revision: 1,
        version: 2,
        sourceGroupId: seeded.groupId,
        assigneeOpenId: seeded.assigneeOpenId,
        taskSpecHash: seeded.taskSpecHash,
      },
      policy: { id: seeded.policyId, version: 1 },
    });
    expect(claim?.clientToken).toMatch(/^iris-task-[0-9a-f]{32}$/u);
    expect(claim?.execution.clientTokenHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(claim?.execution.requestFingerprint).toMatch(/^[0-9a-f]{64}$/u);

    const dispatched = await repository.markExternalAttempt({
      executionId: claim!.execution.id,
      expectedExecutionVersion: claim!.execution.version,
      workerId: "task-executor-success",
      operationKey: `task-execution-dispatch:success:${seeded.suffix}`,
      at: plusSeconds(1),
    });
    expect(dispatched.execution).toMatchObject({ state: "external_attempting", version: 2 });

    const completeInput = {
      proposalId: seeded.proposalId,
      executionId: dispatched.execution.id,
      expectedProposalVersion: dispatched.proposal.version,
      expectedExecutionVersion: dispatched.execution.version,
      expectedDraftVersion: dispatched.draft.version,
      expectedDraftRevision: dispatched.draft.revision,
      taskSpecHash: dispatched.draft.taskSpecHash,
      remoteTaskGuid: `task-guid-${seeded.suffix}`,
      remoteTaskId: `task-id-${seeded.suffix}`,
      remoteTaskUrl: `https://applink.feishu.cn/client/todo/detail?guid=${seeded.suffix}`,
      operationKey: `task-execution-complete:success:${seeded.suffix}`,
      at: plusSeconds(2),
    };
    await repository.completeCreation(completeInput);
    await expect(repository.completeCreation(completeInput)).resolves.toBeUndefined();

    await expect(pool.query(
      `SELECT proposal.status AS proposal_status, draft.status AS draft_status,
              execution.state AS execution_state, execution.remote_task_guid,
              creation.task_spec_hash, presentation.state AS presentation_state,
              outbox.state AS outbox_state
       FROM action_proposals proposal
       JOIN formal_task_drafts draft ON draft.id = proposal.task_draft_id
       JOIN feishu_task_creation_executions execution ON execution.proposal_id = proposal.id
       JOIN feishu_task_creations creation ON creation.execution_id = execution.id
       JOIN feishu_task_result_presentations presentation ON presentation.creation_id = creation.id
       JOIN feishu_task_result_presentation_outbox outbox
         ON outbox.presentation_id = presentation.id
       WHERE proposal.id = $1`,
      [seeded.proposalId],
    )).resolves.toMatchObject({ rows: [{
      proposal_status: "succeeded",
      draft_status: "created",
      execution_state: "succeeded",
      remote_task_guid: completeInput.remoteTaskGuid,
      task_spec_hash: seeded.taskSpecHash,
      presentation_state: "pending_send",
      outbox_state: "pending",
    }] });
    await expect(pool.query(
      `SELECT count(*)::int AS count FROM feishu_task_creations WHERE proposal_id = $1`,
      [seeded.proposalId],
    )).resolves.toMatchObject({ rows: [{ count: 1 }] });

    const resultPresentation = await pool.query<{ id: string }>(
      "SELECT id FROM feishu_task_result_presentations WHERE proposal_id = $1",
      [seeded.proposalId],
    );
    const resultPresentationId = resultPresentation.rows[0]!.id;
    await pool.query(
      `UPDATE feishu_task_result_presentation_outbox
       SET state = 'failed', error_code = 'test_isolation', updated_at = $2
       WHERE presentation_id <> $1 AND state = 'pending'`,
      [resultPresentationId, plusSeconds(3)],
    );
    const resultClaim = await repository.claimResultPresentationSend({
      workerId: "task-result-worker",
      leaseUntil: plusSeconds(33),
      at: plusSeconds(3),
    });
    expect(resultClaim).toMatchObject({
      presentation: {
        id: resultPresentationId,
        proposalId: seeded.proposalId,
        groupId: seeded.groupId,
        state: "pending_send",
      },
      workerId: "task-result-worker",
      attempts: 1,
    });
    await expect(repository.getResultPresentationContext(resultPresentationId))
      .resolves.toMatchObject({
        presentation: { id: resultPresentationId, creationId: expect.any(String) },
        creation: {
          proposalId: seeded.proposalId,
          title: "Archive pilot evidence",
          assigneeOpenId: seeded.assigneeOpenId,
          remoteTaskGuid: completeInput.remoteTaskGuid,
          taskSpecHash: seeded.taskSpecHash,
        },
      });
    await repository.deferResultPresentationSend({
      presentationId: resultPresentationId,
      workerId: "task-result-worker",
      errorCode: "runtime_disabled",
      retryAt: plusSeconds(10),
      at: plusSeconds(4),
    });
    await expect(repository.claimResultPresentationSend({
      workerId: "task-result-worker-paused-early",
      leaseUntil: plusSeconds(39),
      at: plusSeconds(9),
    })).resolves.toBeUndefined();
    const resumedBeforeAttempt = await repository.claimResultPresentationSend({
      workerId: "task-result-worker-resumed-before-attempt",
      leaseUntil: plusSeconds(41),
      at: plusSeconds(11),
    });
    expect(resumedBeforeAttempt).toMatchObject({ attempts: 1 });
    await repository.beginResultPresentationAttempt({
      presentationId: resultPresentationId,
      workerId: "task-result-worker-resumed-before-attempt",
      at: plusSeconds(12),
    });
    await repository.deferResultPresentationSend({
      presentationId: resultPresentationId,
      workerId: "task-result-worker-resumed-before-attempt",
      errorCode: "runtime_disabled",
      retryAt: plusSeconds(20),
      at: plusSeconds(13),
    });
    const resumedImmediatelyBeforeSend = await repository.claimResultPresentationSend({
      workerId: "task-result-worker-resumed-before-send",
      leaseUntil: plusSeconds(51),
      at: plusSeconds(21),
    });
    expect(resumedImmediatelyBeforeSend).toMatchObject({ attempts: 1 });
    await repository.beginResultPresentationAttempt({
      presentationId: resultPresentationId,
      workerId: "task-result-worker-resumed-before-send",
      at: plusSeconds(22),
    });
    await repository.failResultPresentationSend({
      presentationId: resultPresentationId,
      workerId: "task-result-worker-resumed-before-send",
      classification: "retryable",
      errorCode: "request_not_sent",
      retryAt: plusSeconds(64),
      at: plusSeconds(23),
    });
    await expect(repository.claimResultPresentationSend({
      workerId: "task-result-worker-early",
      leaseUntil: plusSeconds(93),
      at: plusSeconds(63),
    })).resolves.toBeUndefined();
    const resultRetry = await repository.claimResultPresentationSend({
      workerId: "task-result-worker-retry",
      leaseUntil: plusSeconds(95),
      at: plusSeconds(65),
    });
    expect(resultRetry).toMatchObject({
      presentation: { id: resultPresentationId, state: "pending_send" },
      attempts: 2,
      workerId: "task-result-worker-retry",
    });
    await repository.beginResultPresentationAttempt({
      presentationId: resultPresentationId,
      workerId: "task-result-worker-retry",
      at: plusSeconds(66),
    });
    await repository.completeResultPresentationSend({
      presentationId: resultPresentationId,
      workerId: "task-result-worker-retry",
      messageId: `om-result-${seeded.suffix}`,
      at: plusSeconds(67),
    });
    await expect(repository.completeResultPresentationSend({
      presentationId: resultPresentationId,
      workerId: "task-result-worker-retry",
      messageId: `om-result-${seeded.suffix}`,
      at: plusSeconds(67),
    })).resolves.toBeUndefined();
    await expect(pool.query(
      `SELECT presentation.state AS presentation_state, presentation.message_id,
              outbox.state AS outbox_state
       FROM feishu_task_result_presentations presentation
       JOIN feishu_task_result_presentation_outbox outbox
         ON outbox.presentation_id = presentation.id
       WHERE presentation.id = $1`,
      [resultPresentationId],
    )).resolves.toMatchObject({ rows: [{
      presentation_state: "sent",
      message_id: `om-result-${seeded.suffix}`,
      outbox_state: "sent",
    }] });
  });

  it("persists a retryable attempt and claims the next attempt with the identical token and request", async () => {
    const seeded = await seedApprovedTask(pool, "retry");
    const repository = createPostgresFormalTaskExecutionRepository({ dataSource: pool });
    const first = await repository.claimNextCreation({
      runtimeGate: runtimeGate(seeded.groupId),
      workerId: "task-executor-retry-1",
      leaseUntil: plusSeconds(30),
      operationKey: `task-execution-claim:retry-1:${seeded.suffix}`,
      at,
    });
    const dispatched = await repository.markExternalAttempt({
      executionId: first!.execution.id,
      expectedExecutionVersion: first!.execution.version,
      workerId: "task-executor-retry-1",
      operationKey: `task-execution-dispatch:retry-1:${seeded.suffix}`,
      at: plusSeconds(1),
    });
    await repository.recordCreationFailure({
      proposalId: seeded.proposalId,
      executionId: dispatched.execution.id,
      expectedProposalVersion: dispatched.proposal.version,
      expectedExecutionVersion: dispatched.execution.version,
      classification: "retryable",
      responseClassification: "rate_limited",
      retryAt: plusSeconds(60),
      operationKey: `task-execution-retryable:${seeded.suffix}`,
      at: plusSeconds(2),
    });

    await expect(repository.claimNextCreation({
      runtimeGate: runtimeGate(seeded.groupId),
      workerId: "task-executor-retry-early",
      leaseUntil: plusSeconds(60),
      operationKey: `task-execution-claim:retry-early:${seeded.suffix}`,
      at: plusSeconds(59),
    })).resolves.toBeUndefined();
    const second = await repository.claimNextCreation({
      runtimeGate: runtimeGate(seeded.groupId),
      workerId: "task-executor-retry-2",
      leaseUntil: plusSeconds(91),
      operationKey: `task-execution-claim:retry-2:${seeded.suffix}`,
      at: plusSeconds(61),
    });
    expect(second).toMatchObject({
      proposal: { id: seeded.proposalId, version: first!.proposal.version },
      execution: { attemptNumber: 2, state: "claimed", version: 1 },
      clientToken: first!.clientToken,
    });
    expect(second?.execution.id).not.toBe(first?.execution.id);
    expect(second?.execution.requestFingerprint).toBe(first?.execution.requestFingerprint);
    expect(second?.execution.clientTokenHash).toBe(first?.execution.clientTokenHash);
  });

  it("does not retry a known-safe request after its approved due time expires", async () => {
    const seeded = await seedApprovedTask(pool, "expired-retry", {
      dueAtUtc: plusSeconds(30).toISOString(),
    });
    const repository = createPostgresFormalTaskExecutionRepository({ dataSource: pool });
    const first = await repository.claimNextCreation({
      runtimeGate: runtimeGate(seeded.groupId),
      workerId: "task-executor-expired-retry-1",
      leaseUntil: plusSeconds(30),
      operationKey: `task-execution-claim:expired-retry-1:${seeded.suffix}`,
      at,
    });
    const dispatched = await repository.markExternalAttempt({
      executionId: first!.execution.id,
      expectedExecutionVersion: first!.execution.version,
      workerId: "task-executor-expired-retry-1",
      operationKey: `task-execution-dispatch:expired-retry-1:${seeded.suffix}`,
      at: plusSeconds(1),
    });
    await repository.recordCreationFailure({
      proposalId: seeded.proposalId,
      executionId: dispatched.execution.id,
      expectedProposalVersion: dispatched.proposal.version,
      expectedExecutionVersion: dispatched.execution.version,
      classification: "retryable",
      responseClassification: "request_not_sent",
      retryAt: plusSeconds(60),
      operationKey: `task-execution-retryable:expired-retry:${seeded.suffix}`,
      at: plusSeconds(2),
    });

    await expect(repository.claimNextCreation({
      runtimeGate: runtimeGate(seeded.groupId),
      workerId: "task-executor-expired-retry-2",
      leaseUntil: plusSeconds(91),
      operationKey: `task-execution-claim:expired-retry-2:${seeded.suffix}`,
      at: plusSeconds(61),
    })).resolves.toBeUndefined();
  });

  it("claims an outcome-unknown reconciliation attempt without changing its token or payload", async () => {
    const seeded = await seedApprovedTask(pool, "reconciliation");
    const repository = createPostgresFormalTaskExecutionRepository({ dataSource: pool });
    const first = await repository.claimNextCreation({
      runtimeGate: runtimeGate(seeded.groupId),
      workerId: "task-executor-unknown",
      leaseUntil: plusSeconds(30),
      operationKey: `task-execution-claim:unknown:${seeded.suffix}`,
      at,
    });
    const dispatched = await repository.markExternalAttempt({
      executionId: first!.execution.id,
      expectedExecutionVersion: first!.execution.version,
      workerId: "task-executor-unknown",
      operationKey: `task-execution-dispatch:unknown:${seeded.suffix}`,
      at: plusSeconds(1),
    });
    await repository.recordCreationFailure({
      proposalId: seeded.proposalId,
      executionId: dispatched.execution.id,
      expectedProposalVersion: dispatched.proposal.version,
      expectedExecutionVersion: dispatched.execution.version,
      classification: "outcome_unknown",
      responseClassification: "timeout",
      retryAt: plusSeconds(60),
      operationKey: `task-execution-unknown:${seeded.suffix}`,
      at: plusSeconds(2),
    });

    const reconciliation = await repository.claimReconciliationAttempt({
      runtimeGate: runtimeGate(seeded.groupId),
      workerId: "task-reconciler",
      leaseUntil: plusSeconds(91),
      operationKey: `task-reconciliation-claim:${seeded.suffix}`,
      at: plusSeconds(61),
    });
    expect(reconciliation).toMatchObject({
      proposal: { id: seeded.proposalId, version: first!.proposal.version },
      execution: {
        id: first!.execution.id,
        state: "external_attempting",
        attemptNumber: 2,
        version: 4,
        workerId: "task-reconciler",
      },
      clientToken: first!.clientToken,
    });
    expect(reconciliation?.execution.requestFingerprint).toBe(first?.execution.requestFingerprint);
    expect(reconciliation?.execution.clientTokenHash).toBe(first?.execution.clientTokenHash);
  });

  it("reports metadata-only execution health and safely reschedules an exact unknown outcome", async () => {
    const seeded = await seedApprovedTask(pool, "operator-reconcile");
    const repository = createPostgresFormalTaskExecutionRepository({ dataSource: pool });
    const first = await repository.claimNextCreation({
      runtimeGate: runtimeGate(seeded.groupId),
      workerId: "task-executor-operator",
      leaseUntil: plusSeconds(30),
      operationKey: `task-execution-claim:operator:${seeded.suffix}`,
      at,
    });
    const dispatched = await repository.markExternalAttempt({
      executionId: first!.execution.id,
      expectedExecutionVersion: first!.execution.version,
      workerId: "task-executor-operator",
      operationKey: `task-execution-dispatch:operator:${seeded.suffix}`,
      at: plusSeconds(1),
    });
    await repository.recordCreationFailure({
      proposalId: seeded.proposalId,
      executionId: dispatched.execution.id,
      expectedProposalVersion: dispatched.proposal.version,
      expectedExecutionVersion: dispatched.execution.version,
      classification: "outcome_unknown",
      responseClassification: "timeout",
      retryAt: plusSeconds(600),
      operationKey: `task-execution-unknown:operator:${seeded.suffix}`,
      at: plusSeconds(2),
    });

    const [metadata] = await repository.listExecutionMetadata({
      states: ["outcome_unknown"],
      proposalId: seeded.proposalId,
      limit: 10,
    });
    expect(metadata).toEqual(expect.objectContaining({
      id: first!.execution.id,
      proposalId: seeded.proposalId,
      draftId: seeded.draftId,
      state: "outcome_unknown",
      version: 3,
      responseClassification: "timeout",
      requestFingerprint: first!.execution.requestFingerprint,
      clientTokenHash: first!.execution.clientTokenHash,
      retryAt: plusSeconds(600),
    }));
    expect(JSON.stringify(metadata)).not.toMatch(
      /assignee|description|remoteTask|taskGuid|taskUrl|clientToken[^H]/iu,
    );

    const operationKey = `task-operator-reconcile:${seeded.suffix}`;
    const request = {
      executionId: first!.execution.id,
      expectedExecutionVersion: 3,
      operationKey,
      operator: "pilot-operator@example.com",
      at: plusSeconds(10),
    };
    await expect(repository.requestReconciliation(request)).resolves.toEqual({
      outcome: "applied",
      executionId: first!.execution.id,
      state: "outcome_unknown",
      version: 4,
      retryAt: plusSeconds(10),
    });
    await expect(repository.requestReconciliation({
      ...request,
      at: plusSeconds(11),
    })).resolves.toEqual({
      outcome: "already_applied",
      executionId: first!.execution.id,
      state: "outcome_unknown",
      version: 4,
      retryAt: plusSeconds(10),
    });
    const status = await repository.getStatusCounts();
    expect(status.migration0057Applied).toBe(true);
    expect(status.executions.outcome_unknown).toBeGreaterThan(0);
    expect(status.results.pending_send).toBeGreaterThanOrEqual(0);
    expect(status.outbox.pending).toBeGreaterThanOrEqual(0);
  });

  it("reclaims a stale pre-dispatch lease without creating another execution attempt", async () => {
    const seeded = await seedApprovedTask(pool, "stale-claim");
    const repository = createPostgresFormalTaskExecutionRepository({ dataSource: pool });
    const first = await repository.claimNextCreation({
      runtimeGate: runtimeGate(seeded.groupId),
      workerId: "task-executor-stale-1",
      leaseUntil: plusSeconds(30),
      operationKey: `task-execution-claim:stale-1:${seeded.suffix}`,
      at,
    });
    const reclaimed = await repository.claimNextCreation({
      runtimeGate: runtimeGate(seeded.groupId),
      workerId: "task-executor-stale-2",
      leaseUntil: plusSeconds(61),
      operationKey: `task-execution-claim:stale-2:${seeded.suffix}`,
      at: plusSeconds(31),
    });
    expect(reclaimed).toMatchObject({
      proposal: { id: seeded.proposalId },
      execution: {
        id: first!.execution.id,
        state: "claimed",
        attemptNumber: 1,
        version: 2,
        workerId: "task-executor-stale-2",
      },
      clientToken: first!.clientToken,
    });
    await expect(pool.query(
      `SELECT count(*)::int AS count
       FROM feishu_task_creation_executions WHERE proposal_id = $1`,
      [seeded.proposalId],
    )).resolves.toMatchObject({ rows: [{ count: 1 }] });
  });

  it("converts an expired post-dispatch lease to unknown before same-token reconciliation", async () => {
    const seeded = await seedApprovedTask(pool, "stale-dispatch");
    const repository = createPostgresFormalTaskExecutionRepository({ dataSource: pool });
    const first = await repository.claimNextCreation({
      runtimeGate: runtimeGate(seeded.groupId),
      workerId: "task-executor-stale-dispatch",
      leaseUntil: plusSeconds(30),
      operationKey: `task-execution-claim:stale-dispatch:${seeded.suffix}`,
      at,
    });
    await repository.markExternalAttempt({
      executionId: first!.execution.id,
      expectedExecutionVersion: first!.execution.version,
      workerId: "task-executor-stale-dispatch",
      operationKey: `task-execution-dispatch:stale-dispatch:${seeded.suffix}`,
      at: plusSeconds(1),
    });

    const reconciliation = await repository.claimReconciliationAttempt({
      runtimeGate: runtimeGate(seeded.groupId),
      workerId: "task-reconciler-stale-dispatch",
      leaseUntil: plusSeconds(61),
      operationKey: `task-reconciliation-claim:stale-dispatch:${seeded.suffix}`,
      at: plusSeconds(31),
    });
    expect(reconciliation).toMatchObject({
      execution: {
        id: first!.execution.id,
        state: "external_attempting",
        attemptNumber: 2,
        version: 4,
        workerId: "task-reconciler-stale-dispatch",
      },
      clientToken: first!.clientToken,
    });
    await expect(pool.query(
      `SELECT event_type, response_classification
       FROM feishu_task_creation_execution_events
       WHERE execution_id = $1 ORDER BY to_version ASC`,
      [first!.execution.id],
    )).resolves.toMatchObject({ rows: [
      { event_type: "claimed", response_classification: null },
      { event_type: "request_dispatched", response_classification: null },
      { event_type: "outcome_unknown", response_classification: "external_attempt_lease_expired" },
      { event_type: "request_dispatched", response_classification: "idempotent_reconciliation_attempt" },
    ] });
  });

  it("fails closed when the group gate or current target policy no longer permits the task", async () => {
    const seeded = await seedApprovedTask(pool, "disabled");
    const repository = createPostgresFormalTaskExecutionRepository({ dataSource: pool });

    await expect(repository.claimNextCreation({
      runtimeGate: runtimeGate("oc_other"),
      workerId: "task-executor-disabled",
      leaseUntil: plusSeconds(30),
      operationKey: `task-execution-claim:wrong-group:${seeded.suffix}`,
      at,
    })).resolves.toBeUndefined();
    await pool.query(
      "UPDATE feishu_task_target_policies SET enabled = FALSE WHERE id = $1",
      [seeded.policyId],
    );
    await expect(repository.claimNextCreation({
      runtimeGate: runtimeGate(seeded.groupId),
      workerId: "task-executor-disabled",
      leaseUntil: plusSeconds(30),
      operationKey: `task-execution-claim:disabled-policy:${seeded.suffix}`,
      at,
    })).resolves.toBeUndefined();
  });

  it("rejects a completion replay whose operation key is rebound to another remote identity", async () => {
    const seeded = await seedApprovedTask(pool, "operation-conflict");
    const repository = createPostgresFormalTaskExecutionRepository({ dataSource: pool });
    const claim = await repository.claimNextCreation({
      runtimeGate: runtimeGate(seeded.groupId),
      workerId: "task-executor-conflict",
      leaseUntil: plusSeconds(30),
      operationKey: `task-execution-claim:conflict:${seeded.suffix}`,
      at,
    });
    const dispatched = await repository.markExternalAttempt({
      executionId: claim!.execution.id,
      expectedExecutionVersion: claim!.execution.version,
      workerId: "task-executor-conflict",
      operationKey: `task-execution-dispatch:conflict:${seeded.suffix}`,
      at: plusSeconds(1),
    });
    const completeInput = {
      proposalId: seeded.proposalId,
      executionId: dispatched.execution.id,
      expectedProposalVersion: dispatched.proposal.version,
      expectedExecutionVersion: dispatched.execution.version,
      expectedDraftVersion: dispatched.draft.version,
      expectedDraftRevision: dispatched.draft.revision,
      taskSpecHash: dispatched.draft.taskSpecHash,
      remoteTaskGuid: `task-guid-${seeded.suffix}`,
      remoteTaskId: `task-id-${seeded.suffix}`,
      remoteTaskUrl: `https://applink.feishu.cn/client/todo/detail?guid=${seeded.suffix}`,
      operationKey: `task-execution-complete:conflict:${seeded.suffix}`,
      at: plusSeconds(2),
    };
    await repository.completeCreation(completeInput);
    await expect(repository.completeCreation({
      ...completeInput,
      remoteTaskGuid: `other-guid-${seeded.suffix}`,
    })).rejects.toBeInstanceOf(FormalTaskExecutionPersistenceConflictError);
  });
});

async function seedApprovedTask(
  pool: pg.Pool,
  label: string,
  overrides: { dueAtUtc?: string } = {},
) {
  const suffix = `${label}-${randomUUID()}`;
  const groupId = `oc_${suffix}`;
  const assigneeOpenId = `ou_${suffix}`;
  const providerMessageId = `om_${suffix}`;
  const evidenceMessageId = `feishu:${providerMessageId}`;
  await pool.query(
    `INSERT INTO conversation_messages (
       id, provider, provider_message_id, chat_id, sender_id, message_type,
       text, sent_at, raw_event_idempotency_key, created_at
     ) VALUES ($1, 'feishu', $2, $3, 'ou_requester', 'text', 'task evidence', $4, $5, $4)`,
    [evidenceMessageId, providerMessageId, groupId, at, `event-${suffix}`],
  );
  const taskRepository = createPostgresFormalTaskRepository({ dataSource: pool });
  const policy = (await taskRepository.upsertTargetPolicy({
    id: `task-policy-${suffix}`,
    sourceGroupId: groupId,
    displayName: "Formal task pilot",
    allowedAssigneeOpenIds: [assigneeOpenId],
    maxDueHorizonDays: 30,
    enabled: true,
    expectedVersion: 0,
    operationKey: `task-policy:${suffix}`,
    operator: "acceptance",
    at,
  })).policy;
  const draft = (await taskRepository.createDraft({
    id: `task-draft-${suffix}`,
    operationKey: `task-draft:${suffix}`,
    createdBy: "ou_requester",
    revision: {
      taskSpec: {
        title: "Archive pilot evidence",
        description: "Verify and archive the exact acceptance evidence.",
        assigneeOpenId,
        dueAtUtc: overrides.dueAtUtc ?? "2026-08-24T06:00:00.123Z",
        reminderMinutes: 30,
        sourceGroupId: groupId,
        targetPolicyId: policy.id,
        targetPolicyVersion: policy.version,
      },
      riskLevel: "high",
      author: "iris",
      evidence: [{ type: "conversation_message", id: evidenceMessageId }],
    },
    at,
  })).draft;
  const cardRepository = createPostgresFormalTaskCardRepository({ dataSource: pool });
  const confirmationPresentationId = `task-confirmation-${suffix}`;
  await cardRepository.createPresentation({
    id: confirmationPresentationId,
    draftId: draft.id,
    expectedDraftVersion: draft.version,
    expectedDraftRevision: draft.currentRevisionNumber,
    taskSpecHash: draft.currentTaskSpecHash,
    groupId,
    operationKey: `task-confirmation:${suffix}`,
    at,
  });
  await pool.query(
    `UPDATE formal_task_draft_presentations
     SET state = 'active', message_id = $2, activated_at = $3
     WHERE id = $1`,
    [confirmationPresentationId, `om-confirmation-${suffix}`, at],
  );
  await pool.query(
    `UPDATE formal_task_draft_presentation_outbox
     SET state = 'sent', updated_at = $2 WHERE presentation_id = $1`,
    [confirmationPresentationId, at],
  );
  const confirmed = (await cardRepository.applyInteraction({
    presentationId: confirmationPresentationId,
    draftId: draft.id,
    draftRevision: draft.currentRevisionNumber,
    draftVersion: draft.version,
    taskSpecHash: draft.currentTaskSpecHash,
    targetPolicyId: policy.id,
    targetPolicyVersion: policy.version,
    groupId,
    eventId: `task-confirmation-callback-${suffix}`,
    actorOpenId: `ou_member_${suffix}`,
    membershipCheckedAt: at,
    at,
    action: "confirm",
  })).draft;
  await pool.query(
    `UPDATE formal_task_draft_presentation_outbox
     SET state = 'failed', error_code = 'test_isolation', updated_at = $2
     WHERE presentation_id = $1 AND state = 'pending'`,
    [confirmationPresentationId, at],
  );
  const actions = createPostgresActionProposalRepository({ dataSource: pool });
  const proposal = (await actions.createProposal({
    proposalId: `proposal-${suffix}`,
    actionType: "create_feishu_task",
    draftId: draft.id,
    expectedRevision: confirmed.currentRevisionNumber,
    expectedDraftVersion: confirmed.version,
    targetPolicyId: policy.id,
    expectedTargetPolicyVersion: policy.version,
    operationKey: `proposal:${suffix}`,
    at,
  })).proposal;
  const review = await actions.getAuthorizedReviewContext({
    proposalId: proposal.id,
    actorOpenId: assigneeOpenId,
  });
  await actions.recordReviewAttestation({
    proposalId: proposal.id,
    actorOpenId: assigneeOpenId,
    expectedProposalVersion: proposal.version,
    expectedSubjectRevision: confirmed.currentRevisionNumber,
    expectedSubjectVersion: confirmed.version,
    expectedContentHash: draft.currentTaskSpecHash,
    expectedActionTargetFingerprint: review!.actionTargetFingerprint,
    sessionIdHash: "7".repeat(64),
    operationKey: `task-review:${suffix}`,
    at,
  });
  const [presentation] = await actions.listApprovalPresentations({
    proposalId: proposal.id,
    limit: 10,
  });
  await pool.query(
    `UPDATE action_approval_presentations
     SET state = 'active', message_id = $2, activated_at = $3
     WHERE id = $1`,
    [presentation!.id, `om-approval-${suffix}`, at],
  );
  await pool.query(
    `UPDATE action_approval_presentation_outbox
     SET state = 'sent', updated_at = $2 WHERE presentation_id = $1`,
    [presentation!.id, at],
  );
  await actions.applyApprovalAction({
    proposalId: proposal.id,
    requirementId: presentation!.requirementId,
    expectedProposalVersion: proposal.version,
    expectedSubjectRevision: confirmed.currentRevisionNumber,
    expectedSubjectVersion: confirmed.version,
    expectedTargetPolicyVersion: policy.version,
    sourcePresentationId: presentation!.id,
    callbackEventId: `task-approval-callback-${suffix}`,
    actorOpenId: assigneeOpenId,
    action: "approve",
    requireReviewAttestation: true,
    membershipCheckedAt: at,
    operationKey: `task-approval:${suffix}`,
    at,
  });
  await pool.query(
    `UPDATE action_approval_presentation_outbox
     SET state = 'failed', error_code = 'test_isolation', updated_at = $2
     WHERE presentation_id = $1 AND state = 'pending'`,
    [presentation!.id, at],
  );
  const approval = await pool.query<{ id: string }>(
    "SELECT id FROM action_approvals WHERE proposal_id = $1",
    [proposal.id],
  );
  return {
    suffix,
    groupId,
    assigneeOpenId,
    policyId: policy.id,
    draftId: draft.id,
    taskSpecHash: draft.currentTaskSpecHash,
    proposalId: proposal.id,
    approvalId: approval.rows[0]!.id,
  };
}

function runtimeGate(groupId: string) {
  return {
    deploymentEnabled: true,
    globalEnabled: true,
    createFeishuTasks: true,
    callExternalTools: true,
    disabledGroupIds: [],
    allowedGroupIds: [groupId],
  };
}

function plusSeconds(seconds: number): Date {
  return new Date(at.getTime() + seconds * 1_000);
}

async function cleanupOwnedOutboxes(pool: pg.Pool): Promise<void> {
  const ownedDraftPattern =
    "^task-draft-(success|retry|expired-retry|reconciliation|operator-reconcile|stale-claim|stale-dispatch|disabled|operation-conflict)-";
  await pool.query(
    `UPDATE formal_task_draft_presentation_outbox outbox
     SET state = 'failed', error_code = 'test_isolation', updated_at = NOW()
     FROM formal_task_draft_presentations presentation
     WHERE presentation.id = outbox.presentation_id
       AND presentation.draft_id ~ $1 AND outbox.state = 'pending'`,
    [ownedDraftPattern],
  );
  await pool.query(
    `UPDATE action_approval_presentation_outbox outbox
     SET state = 'failed', error_code = 'test_isolation', updated_at = NOW()
     FROM action_approval_presentations presentation
     JOIN action_proposals proposal ON proposal.id = presentation.proposal_id
     WHERE presentation.id = outbox.presentation_id
       AND proposal.task_draft_id ~ $1 AND outbox.state = 'pending'`,
    [ownedDraftPattern],
  );
}
