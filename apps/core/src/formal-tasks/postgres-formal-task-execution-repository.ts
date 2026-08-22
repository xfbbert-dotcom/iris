import { createHash, randomUUID } from "node:crypto";

import type {
  ClaimedFeishuTaskCreation,
  CompleteFeishuTaskCreationInput,
  FeishuTaskCreation,
  FeishuTaskCreationExecution,
  FeishuTaskCreationRuntimeGate,
  FormalTaskExecutionMetadata,
  FormalTaskExecutionStatusCounts,
  FeishuTaskResultPresentation,
  FeishuTaskResultPresentationContext,
  FeishuTaskResultSendClaim,
  FormalTaskExecutionRepository,
  RecordFeishuTaskCreationFailureInput,
  RequestFormalTaskReconciliationInput,
  RequestFormalTaskReconciliationResult,
} from "./formal-task-execution-repository.js";
import type { PostgresFormalTaskDataSource } from "./postgres-formal-task-repository.js";

type TransactionClient = Awaited<ReturnType<PostgresFormalTaskDataSource["connect"]>>;

type ExecutionRow = {
  id: string;
  proposal_id: string;
  approval_id: string;
  draft_id: string;
  draft_revision: string | number;
  draft_version: string | number;
  target_policy_id: string;
  target_policy_version: string | number;
  assignee_open_id: string;
  attempt_number: string | number;
  state: FeishuTaskCreationExecution["state"];
  request_fingerprint: string;
  client_token_hash: string;
  operation_key: string;
  response_classification: string | null;
  remote_task_guid: string | null;
  remote_task_id: string | null;
  remote_task_url: string | null;
  worker_id: string | null;
  lease_until: Date | null;
  retry_at: Date | null;
  version: string | number;
  dispatched_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

type ClaimRow = ExecutionRow & {
  proposal_version: string | number;
  title: string;
  description: string;
  source_group_id: string;
  due_at: Date | null;
  reminder_minutes: string | number | null;
  task_spec_hash: string;
  policy_id: string;
  policy_version: string | number;
};

type CreationReplayRow = {
  proposal_id: string;
  execution_id: string;
  draft_id: string;
  draft_revision: string | number;
  draft_version: string | number;
  task_spec_hash: string;
  remote_task_guid: string;
  remote_task_id: string;
  remote_task_url: string;
  operation_fingerprint: string;
};

type ResultPresentationRow = {
  id: string;
  creation_id: string;
  proposal_id: string;
  group_id: string;
  state: FeishuTaskResultPresentation["state"];
  message_id: string | null;
  operation_key: string;
  operation_fingerprint: string;
  version: string | number;
  created_at: Date;
  sent_at: Date | null;
  updated_at: Date;
};

type ResultOutboxRow = {
  id: string;
  presentation_id: string;
  state: "pending" | "processing" | "external_attempting" | "sent" | "failed" |
    "outcome_unknown";
  attempts: string | number;
  worker_id: string | null;
  lease_until: Date | null;
  retry_at: Date | null;
  error_code: string | null;
};

type ExecutionMetadataRow = Pick<ExecutionRow,
  "id" | "proposal_id" | "draft_id" | "draft_revision" | "draft_version" |
  "target_policy_id" | "target_policy_version" | "attempt_number" | "state" |
  "request_fingerprint" | "client_token_hash" | "response_classification" |
  "version" | "lease_until" | "retry_at" | "dispatched_at" | "created_at" |
  "updated_at"
>;

export class FormalTaskExecutionPersistenceConflictError extends Error {
  constructor() {
    super("formal task execution state or binding is stale");
    this.name = "FormalTaskExecutionPersistenceConflictError";
  }
}

export class FormalTaskExecutionOperationConflictError extends Error {
  constructor() {
    super("formal task execution operation conflicts with an existing operation");
    this.name = "FormalTaskExecutionOperationConflictError";
  }
}

export function createPostgresFormalTaskExecutionRepository({
  dataSource,
}: {
  dataSource: PostgresFormalTaskDataSource;
}): FormalTaskExecutionRepository {
  return {
    getStatusCounts: () => getStatusCounts(dataSource),
    listExecutionMetadata: (input) => listExecutionMetadata(dataSource, input),
    requestReconciliation: (input) => requestReconciliation(dataSource, input),
    claimNextCreation: (input) => claimNextCreation(dataSource, input),
    claimReconciliationAttempt: (input) => claimReconciliationAttempt(dataSource, input),
    markExternalAttempt: (input) => markExternalAttempt(dataSource, input),
    completeCreation: (input) => completeCreation(dataSource, input),
    recordCreationFailure: (input) => recordCreationFailure(dataSource, input),
    claimResultPresentationSend: (input) => claimResultPresentationSend(dataSource, input),
    getResultPresentationContext: (id) => getResultPresentationContext(dataSource, id),
    beginResultPresentationAttempt: (input) => beginResultPresentationAttempt(dataSource, input),
    failResultPresentationPreparation: (input) => failResultPresentationPreparation(dataSource, input),
    completeResultPresentationSend: (input) => completeResultPresentationSend(dataSource, input),
    failResultPresentationSend: (input) => failResultPresentationSend(dataSource, input),
  };
}

async function getStatusCounts(
  dataSource: PostgresFormalTaskDataSource,
): Promise<FormalTaskExecutionStatusCounts> {
  const [migration, executions, results, outbox] = await Promise.all([
    dataSource.query<{ applied: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM schema_migrations
         WHERE name = '0057_governed_feishu_task_actions.sql'
       ) AS applied`,
    ),
    dataSource.query<{ state: FeishuTaskCreationExecution["state"]; count: string | number }>(
      "SELECT state, count(*) AS count FROM feishu_task_creation_executions GROUP BY state",
    ),
    dataSource.query<{ state: FeishuTaskResultPresentation["state"]; count: string | number }>(
      "SELECT state, count(*) AS count FROM feishu_task_result_presentations GROUP BY state",
    ),
    dataSource.query<{
      state: keyof FormalTaskExecutionStatusCounts["outbox"];
      count: string | number;
    }>(
      "SELECT state, count(*) AS count FROM feishu_task_result_presentation_outbox GROUP BY state",
    ),
  ]);
  return {
    migration0057Applied: migration.rows[0]?.applied === true,
    executions: mapCounts(
      ["claimed", "external_attempting", "succeeded", "failed", "outcome_unknown", "reconciliation_required"],
      executions.rows,
    ),
    results: mapCounts(
      ["pending_send", "sent", "failed", "outcome_unknown"],
      results.rows,
    ),
    outbox: mapCounts(
      ["pending", "processing", "external_attempting", "sent", "failed", "outcome_unknown"],
      outbox.rows,
    ),
  };
}

async function listExecutionMetadata(
  dataSource: PostgresFormalTaskDataSource,
  input: Parameters<FormalTaskExecutionRepository["listExecutionMetadata"]>[0],
): Promise<FormalTaskExecutionMetadata[]> {
  const states = input.states === undefined
    ? undefined
    : normalizeExecutionStates(input.states);
  const proposalId = input.proposalId === undefined
    ? undefined
    : requireReference("proposalId", input.proposalId);
  const limit = requireIntegerBetween("limit", input.limit, 1, 100);
  const result = await dataSource.query<ExecutionMetadataRow>(
    `SELECT id, proposal_id, draft_id, draft_revision, draft_version,
            target_policy_id, target_policy_version, attempt_number, state,
            request_fingerprint, client_token_hash, response_classification,
            version, lease_until, retry_at, dispatched_at, created_at, updated_at
     FROM feishu_task_creation_executions
     WHERE ($1::text[] IS NULL OR state = ANY($1::text[]))
       AND ($2::text IS NULL OR proposal_id = $2)
     ORDER BY updated_at DESC, id ASC
     LIMIT $3`,
    [states ?? null, proposalId ?? null, limit],
  );
  return result.rows.map(mapExecutionMetadata);
}

async function requestReconciliation(
  dataSource: PostgresFormalTaskDataSource,
  input: RequestFormalTaskReconciliationInput,
): Promise<RequestFormalTaskReconciliationResult> {
  const normalized = {
    executionId: requireReference("executionId", input.executionId),
    expectedExecutionVersion: requirePositiveInteger(
      "expectedExecutionVersion",
      input.expectedExecutionVersion,
    ),
    operationKey: requireReference("operationKey", input.operationKey),
    operator: requireReference("operator", input.operator),
    at: requireDate(input.at),
  };
  const responseClassification = `operator_reconciliation_requested:${hash(JSON.stringify({
    executionId: normalized.executionId,
    expectedExecutionVersion: normalized.expectedExecutionVersion,
    operator: normalized.operator,
  }))}`;
  return withTransaction(dataSource, async (client) => {
    const execution = await lockExecution(client, normalized.executionId);
    const replay = await client.query<{
      execution_id: string;
      event_type: string;
      from_version: string | number | null;
      to_version: string | number;
      response_classification: string | null;
      created_at: Date;
    }>(
      `SELECT execution_id, event_type, from_version, to_version,
              response_classification, created_at
       FROM feishu_task_creation_execution_events
       WHERE operation_key = $1`,
      [normalized.operationKey],
    );
    if (replay.rows[0] !== undefined) {
      const event = replay.rows[0];
      if (
        event.execution_id !== normalized.executionId ||
        event.event_type !== "outcome_unknown" ||
        Number(event.from_version) !== normalized.expectedExecutionVersion ||
        event.response_classification !== responseClassification
      ) throw new FormalTaskExecutionOperationConflictError();
      return {
        outcome: "already_applied",
        executionId: normalized.executionId,
        state: "outcome_unknown",
        version: Number(event.to_version),
        retryAt: requireDate(event.created_at),
      };
    }
    if (
      execution.state !== "outcome_unknown" ||
      Number(execution.version) !== normalized.expectedExecutionVersion
    ) throw new FormalTaskExecutionPersistenceConflictError();
    const nextVersion = normalized.expectedExecutionVersion + 1;
    const updated = await client.query<{ id: string }>(
      `UPDATE feishu_task_creation_executions
       SET retry_at = $2, worker_id = NULL, lease_until = NULL,
           version = $3, updated_at = $2
       WHERE id = $1 AND state = 'outcome_unknown' AND version = $4
       RETURNING id`,
      [normalized.executionId, normalized.at, nextVersion, normalized.expectedExecutionVersion],
    );
    if (updated.rows.length !== 1) throw new FormalTaskExecutionPersistenceConflictError();
    await insertExecutionEvent(client, {
      executionId: normalized.executionId,
      eventType: "outcome_unknown",
      operationKey: normalized.operationKey,
      fromVersion: normalized.expectedExecutionVersion,
      toVersion: nextVersion,
      responseClassification,
      at: normalized.at,
    });
    return {
      outcome: "applied",
      executionId: normalized.executionId,
      state: "outcome_unknown",
      version: nextVersion,
      retryAt: normalized.at,
    };
  });
}

async function claimReconciliationAttempt(
  dataSource: PostgresFormalTaskDataSource,
  input: Parameters<FormalTaskExecutionRepository["claimReconciliationAttempt"]>[0],
): Promise<ClaimedFeishuTaskCreation | undefined> {
  const normalized = normalizeClaim(input);
  if (!canClaim(normalized.runtimeGate)) return undefined;
  return withTransaction(dataSource, async (client) => {
    await expireStaleExternalExecution(client, normalized.runtimeGate, normalized.at);
    const candidate = await client.query<ExecutionRow>(
      `${executionSelect("execution")}
       JOIN action_proposals proposal ON proposal.id = execution.proposal_id
       JOIN formal_task_drafts draft ON draft.id = execution.draft_id
       JOIN formal_task_draft_revisions revision
         ON revision.draft_id = execution.draft_id
        AND revision.revision_number = execution.draft_revision
       JOIN feishu_task_target_policies policy ON policy.id = execution.target_policy_id
       WHERE execution.state = 'outcome_unknown' AND execution.retry_at <= $1
         AND proposal.status = 'executing'
         AND ${currentBindingPredicate()}
         AND draft.source_group_id = ANY($2::text[])
         AND NOT (draft.source_group_id = ANY($3::text[]))
       ORDER BY execution.retry_at ASC, execution.created_at ASC, execution.id ASC
       FOR UPDATE OF execution, proposal SKIP LOCKED LIMIT 1`,
      [normalized.at, normalized.runtimeGate.allowedGroupIds, normalized.runtimeGate.disabledGroupIds],
    );
    const execution = candidate.rows[0];
    if (execution === undefined) return undefined;
    const fromVersion = Number(execution.version);
    const nextAttempt = Number(execution.attempt_number) + 1;
    const eventOperationKey = derivedOperationKey(normalized.operationKey, [
      execution.id,
      nextAttempt,
    ]);
    const updated = await client.query<{ id: string }>(
      `UPDATE feishu_task_creation_executions
       SET state = 'external_attempting', attempt_number = $2,
           worker_id = $3, lease_until = $4, retry_at = NULL,
           dispatched_at = $5, version = version + 1, updated_at = $5
       WHERE id = $1 AND state = 'outcome_unknown' AND version = $6
       RETURNING id`,
      [
        execution.id,
        nextAttempt,
        normalized.workerId,
        normalized.leaseUntil,
        normalized.at,
        fromVersion,
      ],
    );
    if (updated.rows.length !== 1) throw new FormalTaskExecutionPersistenceConflictError();
    await insertExecutionEvent(client, {
      executionId: execution.id,
      eventType: "request_dispatched",
      operationKey: eventOperationKey,
      fromVersion,
      toVersion: fromVersion + 1,
      responseClassification: "idempotent_reconciliation_attempt",
      at: normalized.at,
    });
    return requireClaim(await loadClaim(client, execution.id));
  });
}

async function claimNextCreation(
  dataSource: PostgresFormalTaskDataSource,
  input: Parameters<FormalTaskExecutionRepository["claimNextCreation"]>[0],
): Promise<ClaimedFeishuTaskCreation | undefined> {
  const normalized = normalizeClaim(input);
  if (!canClaim(normalized.runtimeGate)) return undefined;
  return withTransaction(dataSource, async (client) => {
    const reclaimed = await reclaimStaleUndispatchedExecution(client, normalized);
    if (reclaimed !== undefined) return reclaimed;
    const retry = await lockRetryCandidate(client, normalized.runtimeGate, normalized.at);
    if (retry !== undefined) {
      const attemptNumber = Number(retry.attempt_number) + 1;
      const executionId = stableId("formal-task-execution", [retry.proposal_id, attemptNumber]);
      const operationKey = derivedOperationKey(normalized.operationKey, [
        retry.proposal_id,
        attemptNumber,
      ]);
      await insertExecution(client, {
        id: executionId,
        proposalId: retry.proposal_id,
        approvalId: retry.approval_id,
        draftId: retry.draft_id,
        draftRevision: Number(retry.draft_revision),
        draftVersion: Number(retry.draft_version),
        targetPolicyId: retry.target_policy_id,
        targetPolicyVersion: Number(retry.target_policy_version),
        assigneeOpenId: retry.assignee_open_id,
        attemptNumber,
        requestFingerprint: retry.request_fingerprint,
        clientTokenHash: retry.client_token_hash,
        operationKey,
        workerId: normalized.workerId,
        leaseUntil: normalized.leaseUntil,
        at: normalized.at,
      });
      return loadClaim(client, executionId);
    }

    const candidate = await lockApprovedCandidate(client, normalized.runtimeGate, normalized.at);
    if (candidate === undefined) return undefined;
    const clientToken = createClientToken(candidate.proposal_id, candidate.task_spec_hash);
    const requestFingerprint = createRequestFingerprint({
      proposalId: candidate.proposal_id,
      draftId: candidate.draft_id,
      draftRevision: Number(candidate.draft_revision),
      draftVersion: Number(candidate.draft_version),
      title: candidate.title,
      description: candidate.description,
      assigneeOpenId: candidate.assignee_open_id,
      dueAt: candidate.due_at,
      reminderMinutes: candidate.reminder_minutes === null
        ? undefined
        : Number(candidate.reminder_minutes),
      taskSpecHash: candidate.task_spec_hash,
      targetPolicyId: candidate.target_policy_id,
      targetPolicyVersion: Number(candidate.target_policy_version),
      clientToken,
    });
    const executionId = stableId("formal-task-execution", [candidate.proposal_id, 1]);
    const operationKey = derivedOperationKey(normalized.operationKey, [candidate.proposal_id, 1]);
    await insertExecution(client, {
      id: executionId,
      proposalId: candidate.proposal_id,
      approvalId: candidate.approval_id,
      draftId: candidate.draft_id,
      draftRevision: Number(candidate.draft_revision),
      draftVersion: Number(candidate.draft_version),
      targetPolicyId: candidate.target_policy_id,
      targetPolicyVersion: Number(candidate.target_policy_version),
      assigneeOpenId: candidate.assignee_open_id,
      attemptNumber: 1,
      requestFingerprint,
      clientTokenHash: hash(clientToken),
      operationKey,
      workerId: normalized.workerId,
      leaseUntil: normalized.leaseUntil,
      at: normalized.at,
    });
    const proposalVersion = Number(candidate.proposal_version);
    const updated = await client.query<{ id: string }>(
      `UPDATE action_proposals
       SET status = 'executing', version = version + 1, updated_at = $2
       WHERE id = $1 AND status = 'approved' AND version = $3
       RETURNING id`,
      [candidate.proposal_id, normalized.at, proposalVersion],
    );
    if (updated.rows.length !== 1) throw new FormalTaskExecutionPersistenceConflictError();
    await client.query(
      `INSERT INTO action_events (
         id, proposal_id, event_type, operation_key, from_version, to_version,
         reason_code, created_at
       ) VALUES ($1, $2, 'execution_started', $3, $4, $5, 'formal_task_claimed', $6)`,
      [
        randomUUID(),
        candidate.proposal_id,
        derivedOperationKey("formal-task-proposal-execution-started", [executionId]),
        proposalVersion,
        proposalVersion + 1,
        normalized.at,
      ],
    );
    return loadClaim(client, executionId);
  });
}

async function reclaimStaleUndispatchedExecution(
  client: TransactionClient,
  input: ReturnType<typeof normalizeClaim>,
): Promise<ClaimedFeishuTaskCreation | undefined> {
  const candidate = await client.query<ExecutionRow>(
    `${executionSelect("execution")}
     JOIN action_proposals proposal ON proposal.id = execution.proposal_id
     JOIN formal_task_drafts draft ON draft.id = execution.draft_id
     JOIN formal_task_draft_revisions revision
       ON revision.draft_id = execution.draft_id
      AND revision.revision_number = execution.draft_revision
     JOIN feishu_task_target_policies policy ON policy.id = execution.target_policy_id
     WHERE execution.state = 'claimed' AND execution.lease_until < $1
       AND proposal.status = 'executing'
       AND ${currentBindingPredicate()}
       AND draft.source_group_id = ANY($2::text[])
       AND NOT (draft.source_group_id = ANY($3::text[]))
     ORDER BY execution.lease_until ASC, execution.created_at ASC, execution.id ASC
     FOR UPDATE OF execution, proposal SKIP LOCKED LIMIT 1`,
    [input.at, input.runtimeGate.allowedGroupIds, input.runtimeGate.disabledGroupIds],
  );
  const execution = candidate.rows[0];
  if (execution === undefined) return undefined;
  const fromVersion = Number(execution.version);
  const eventOperationKey = derivedOperationKey(input.operationKey, [
    execution.id,
    "stale-undispatched",
    fromVersion,
  ]);
  const updated = await client.query<{ id: string }>(
    `UPDATE feishu_task_creation_executions
     SET worker_id = $2, lease_until = $3, version = version + 1, updated_at = $4
     WHERE id = $1 AND state = 'claimed' AND version = $5
     RETURNING id`,
    [execution.id, input.workerId, input.leaseUntil, input.at, fromVersion],
  );
  if (updated.rows.length !== 1) throw new FormalTaskExecutionPersistenceConflictError();
  await insertExecutionEvent(client, {
    executionId: execution.id,
    eventType: "claimed",
    operationKey: eventOperationKey,
    fromVersion,
    toVersion: fromVersion + 1,
    responseClassification: "stale_undispatched_reclaimed",
    at: input.at,
  });
  return requireClaim(await loadClaim(client, execution.id));
}

async function expireStaleExternalExecution(
  client: TransactionClient,
  gate: FeishuTaskCreationRuntimeGate,
  at: Date,
): Promise<void> {
  const candidate = await client.query<ExecutionRow>(
    `${executionSelect("execution")}
     JOIN action_proposals proposal ON proposal.id = execution.proposal_id
     JOIN formal_task_drafts draft ON draft.id = execution.draft_id
     JOIN formal_task_draft_revisions revision
       ON revision.draft_id = execution.draft_id
      AND revision.revision_number = execution.draft_revision
     JOIN feishu_task_target_policies policy ON policy.id = execution.target_policy_id
     WHERE execution.state = 'external_attempting' AND execution.lease_until < $1
       AND proposal.status = 'executing'
       AND ${currentBindingPredicate()}
       AND draft.source_group_id = ANY($2::text[])
       AND NOT (draft.source_group_id = ANY($3::text[]))
     ORDER BY execution.lease_until ASC, execution.created_at ASC, execution.id ASC
     FOR UPDATE OF execution, proposal SKIP LOCKED LIMIT 1`,
    [at, gate.allowedGroupIds, gate.disabledGroupIds],
  );
  const execution = candidate.rows[0];
  if (execution === undefined) return;
  const fromVersion = Number(execution.version);
  const responseClassification = "external_attempt_lease_expired";
  const updated = await client.query<{ id: string }>(
    `UPDATE feishu_task_creation_executions
     SET state = 'outcome_unknown', response_classification = $2,
         worker_id = NULL, lease_until = NULL, retry_at = $3,
         version = version + 1, updated_at = $3
     WHERE id = $1 AND state = 'external_attempting' AND version = $4
     RETURNING id`,
    [execution.id, responseClassification, at, fromVersion],
  );
  if (updated.rows.length !== 1) throw new FormalTaskExecutionPersistenceConflictError();
  await insertExecutionEvent(client, {
    executionId: execution.id,
    eventType: "outcome_unknown",
    operationKey: derivedOperationKey("formal-task-stale-dispatch-outcome-unknown", [
      execution.id,
      fromVersion,
    ]),
    fromVersion,
    toVersion: fromVersion + 1,
    responseClassification,
    at,
  });
}

async function markExternalAttempt(
  dataSource: PostgresFormalTaskDataSource,
  input: Parameters<FormalTaskExecutionRepository["markExternalAttempt"]>[0],
): Promise<ClaimedFeishuTaskCreation> {
  const normalized = {
    executionId: requireReference("executionId", input.executionId),
    expectedExecutionVersion: requirePositiveInteger(
      "expectedExecutionVersion",
      input.expectedExecutionVersion,
    ),
    workerId: requireReference("workerId", input.workerId),
    operationKey: requireReference("operationKey", input.operationKey),
    at: requireDate(input.at),
  };
  return withTransaction(dataSource, async (client) => {
    const replay = await client.query<{ execution_id: string }>(
      `SELECT execution_id FROM feishu_task_creation_execution_events
       WHERE operation_key = $1`,
      [normalized.operationKey],
    );
    if (replay.rows[0] !== undefined) {
      if (replay.rows[0].execution_id !== normalized.executionId) {
        throw new FormalTaskExecutionOperationConflictError();
      }
      return requireClaim(await loadClaim(client, normalized.executionId));
    }
    const execution = await lockExecution(client, normalized.executionId);
    if (
      execution.state !== "claimed" ||
      Number(execution.version) !== normalized.expectedExecutionVersion ||
      execution.worker_id !== normalized.workerId ||
      execution.lease_until === null ||
      execution.lease_until.getTime() < normalized.at.getTime()
    ) throw new FormalTaskExecutionPersistenceConflictError();
    const fromVersion = Number(execution.version);
    const updated = await client.query<{ id: string }>(
      `UPDATE feishu_task_creation_executions
       SET state = 'external_attempting', dispatched_at = $2, version = version + 1,
           updated_at = $2
       WHERE id = $1 AND state = 'claimed' AND version = $3
       RETURNING id`,
      [normalized.executionId, normalized.at, fromVersion],
    );
    if (updated.rows.length !== 1) throw new FormalTaskExecutionPersistenceConflictError();
    await insertExecutionEvent(client, {
      executionId: normalized.executionId,
      eventType: "request_dispatched",
      operationKey: normalized.operationKey,
      fromVersion,
      toVersion: fromVersion + 1,
      at: normalized.at,
    });
    return requireClaim(await loadClaim(client, normalized.executionId));
  });
}

async function recordCreationFailure(
  dataSource: PostgresFormalTaskDataSource,
  input: RecordFeishuTaskCreationFailureInput,
): Promise<void> {
  const normalized = normalizeFailure(input);
  await withTransaction(dataSource, async (client) => {
    const replay = await client.query<{
      execution_id: string;
      event_type: string;
      response_classification: string | null;
    }>(
      `SELECT execution_id, event_type, response_classification
       FROM feishu_task_creation_execution_events WHERE operation_key = $1`,
      [normalized.operationKey],
    );
    const expectedEvent = failureEventType(normalized.classification);
    if (replay.rows[0] !== undefined) {
      if (
        replay.rows[0].execution_id !== normalized.executionId ||
        replay.rows[0].event_type !== expectedEvent ||
        replay.rows[0].response_classification !== normalized.responseClassification
      ) throw new FormalTaskExecutionOperationConflictError();
      return;
    }
    const proposal = await lockProposal(client, normalized.proposalId);
    const execution = await lockExecution(client, normalized.executionId);
    if (
      execution.proposal_id !== proposal.id ||
      Number(proposal.version) !== normalized.expectedProposalVersion ||
      Number(execution.version) !== normalized.expectedExecutionVersion ||
      !(execution.state === "claimed" || execution.state === "external_attempting")
    ) throw new FormalTaskExecutionPersistenceConflictError();
    const nextState = normalized.classification === "outcome_unknown"
      ? "outcome_unknown"
      : normalized.classification === "reconciliation_required"
        ? "reconciliation_required"
        : "failed";
    const fromVersion = Number(execution.version);
    await client.query(
      `UPDATE feishu_task_creation_executions
       SET state = $2, response_classification = $3,
           remote_task_guid = $4, remote_task_id = $5, remote_task_url = $6,
           worker_id = NULL, lease_until = NULL, retry_at = $7,
           version = version + 1, updated_at = $8
       WHERE id = $1 AND version = $9`,
      [
        normalized.executionId,
        nextState,
        normalized.responseClassification,
        normalized.remoteTaskGuid ?? null,
        normalized.remoteTaskId ?? null,
        normalized.remoteTaskUrl ?? null,
        normalized.retryAt ?? null,
        normalized.at,
        fromVersion,
      ],
    );
    await insertExecutionEvent(client, {
      executionId: normalized.executionId,
      eventType: expectedEvent,
      operationKey: normalized.operationKey,
      fromVersion,
      toVersion: fromVersion + 1,
      responseClassification: normalized.responseClassification,
      at: normalized.at,
    });
    if (normalized.classification === "retryable" || normalized.classification === "outcome_unknown") {
      return;
    }
    const proposalStatus = normalized.classification === "reconciliation_required"
      ? "reconciliation_required"
      : "failed";
    const proposalEvent = normalized.classification === "reconciliation_required"
      ? "execution_reconciliation_required"
      : "execution_failed";
    const proposalVersion = Number(proposal.version);
    await client.query(
      `UPDATE action_proposals SET status = $2, version = version + 1, updated_at = $3
       WHERE id = $1 AND status = 'executing' AND version = $4`,
      [normalized.proposalId, proposalStatus, normalized.at, proposalVersion],
    );
    await client.query(
      `INSERT INTO action_events (
         id, proposal_id, event_type, operation_key, from_version, to_version,
         reason_code, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        randomUUID(),
        normalized.proposalId,
        proposalEvent,
        derivedOperationKey(`formal-task-proposal-${proposalEvent}`, [normalized.operationKey]),
        proposalVersion,
        proposalVersion + 1,
        normalized.responseClassification,
        normalized.at,
      ],
    );
  });
}

async function completeCreation(
  dataSource: PostgresFormalTaskDataSource,
  input: CompleteFeishuTaskCreationInput,
): Promise<void> {
  const normalized = normalizeComplete(input);
  const fingerprint = operationFingerprint({ operation: "complete_feishu_task_creation", ...normalized });
  await withTransaction(dataSource, async (client) => {
    const replay = await client.query<CreationReplayRow>(
      `SELECT proposal_id, execution_id, draft_id, draft_revision, draft_version,
              task_spec_hash, remote_task_guid, remote_task_id, remote_task_url,
              operation_fingerprint
       FROM feishu_task_creations WHERE operation_key = $1`,
      [normalized.operationKey],
    );
    if (replay.rows[0] !== undefined) {
      if (replay.rows[0].operation_fingerprint !== fingerprint) {
        throw new FormalTaskExecutionPersistenceConflictError();
      }
      return;
    }
    const proposal = await lockProposal(client, normalized.proposalId);
    const execution = await lockExecution(client, normalized.executionId);
    const draftResult = await client.query<{
      id: string;
      status: string;
      current_revision_number: string | number;
      version: string | number;
      current_task_spec_hash: string;
      source_group_id: string;
      due_at: Date | null;
      reminder_minutes: string | number | null;
    }>(
      `SELECT draft.id, draft.status, draft.current_revision_number, draft.version,
              draft.current_task_spec_hash, draft.source_group_id,
              revision.due_at, revision.reminder_minutes
       FROM formal_task_drafts draft
       JOIN formal_task_draft_revisions revision
         ON revision.draft_id = draft.id
        AND revision.revision_number = draft.current_revision_number
       WHERE draft.id = $1 FOR UPDATE OF draft`,
      [execution.draft_id],
    );
    const draft = draftResult.rows[0];
    if (
      draft === undefined ||
      proposal.id !== execution.proposal_id ||
      proposal.status !== "executing" ||
      Number(proposal.version) !== normalized.expectedProposalVersion ||
      execution.state !== "external_attempting" ||
      Number(execution.version) !== normalized.expectedExecutionVersion ||
      draft.status !== "pending_review" ||
      Number(draft.version) !== normalized.expectedDraftVersion ||
      Number(draft.current_revision_number) !== normalized.expectedDraftRevision ||
      draft.current_task_spec_hash !== normalized.taskSpecHash ||
      execution.draft_id !== draft.id ||
      Number(execution.draft_revision) !== normalized.expectedDraftRevision ||
      Number(execution.draft_version) !== normalized.expectedDraftVersion
    ) throw new FormalTaskExecutionPersistenceConflictError();

    const creationId = stableId("feishu-task-creation", [normalized.proposalId]);
    await client.query(
      `INSERT INTO feishu_task_creations (
         id, proposal_id, approval_id, execution_id, draft_id, draft_revision,
         draft_version, target_policy_id, target_policy_version, assignee_open_id,
         due_at, reminder_minutes, remote_task_guid, remote_task_id, remote_task_url,
         task_spec_hash, operation_key, operation_fingerprint, completed_at, created_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
         $11, $12, $13, $14, $15, $16, $17, $18, $19, $19
       )`,
      [
        creationId,
        normalized.proposalId,
        execution.approval_id,
        normalized.executionId,
        draft.id,
        normalized.expectedDraftRevision,
        normalized.expectedDraftVersion,
        execution.target_policy_id,
        Number(execution.target_policy_version),
        execution.assignee_open_id,
        draft.due_at,
        draft.reminder_minutes,
        normalized.remoteTaskGuid,
        normalized.remoteTaskId,
        normalized.remoteTaskUrl,
        normalized.taskSpecHash,
        normalized.operationKey,
        fingerprint,
        normalized.at,
      ],
    );
    const executionVersion = Number(execution.version);
    await client.query(
      `UPDATE feishu_task_creation_executions
       SET state = 'succeeded', response_classification = 'created',
           remote_task_guid = $2, remote_task_id = $3, remote_task_url = $4,
           worker_id = NULL, lease_until = NULL, retry_at = NULL,
           version = version + 1, updated_at = $5
       WHERE id = $1 AND state = 'external_attempting' AND version = $6`,
      [
        normalized.executionId,
        normalized.remoteTaskGuid,
        normalized.remoteTaskId,
        normalized.remoteTaskUrl,
        normalized.at,
        executionVersion,
      ],
    );
    await insertExecutionEvent(client, {
      executionId: normalized.executionId,
      eventType: "succeeded",
      operationKey: derivedOperationKey("formal-task-execution-succeeded", [normalized.operationKey]),
      fromVersion: executionVersion,
      toVersion: executionVersion + 1,
      responseClassification: "created",
      at: normalized.at,
    });
    const proposalVersion = Number(proposal.version);
    await client.query(
      `UPDATE action_proposals
       SET status = 'succeeded', version = version + 1, updated_at = $2
       WHERE id = $1 AND status = 'executing' AND version = $3`,
      [normalized.proposalId, normalized.at, proposalVersion],
    );
    await client.query(
      `INSERT INTO action_events (
         id, proposal_id, event_type, operation_key, from_version, to_version,
         reason_code, created_at
       ) VALUES ($1, $2, 'execution_succeeded', $3, $4, $5, 'feishu_task_created', $6)`,
      [
        randomUUID(),
        normalized.proposalId,
        derivedOperationKey("formal-task-proposal-succeeded", [normalized.operationKey]),
        proposalVersion,
        proposalVersion + 1,
        normalized.at,
      ],
    );
    const draftVersion = Number(draft.version);
    await client.query(
      `UPDATE formal_task_drafts
       SET status = 'created', version = version + 1, updated_at = $2
       WHERE id = $1 AND status = 'pending_review' AND version = $3`,
      [draft.id, normalized.at, draftVersion],
    );
    await client.query(
      `INSERT INTO formal_task_draft_events (
         id, draft_id, event_type, from_version, to_version, operation_key,
         operation_fingerprint, actor, reason, revision_number, created_at
       ) VALUES ($1, $2, 'task_created', $3, $4, $5, $6,
         'iris-formal-task-executor', NULL, $7, $8)`,
      [
        randomUUID(),
        draft.id,
        draftVersion,
        draftVersion + 1,
        derivedOperationKey("formal-task-draft-created", [normalized.operationKey]),
        operationFingerprint({
          draftId: draft.id,
          executionId: normalized.executionId,
          remoteTaskGuid: normalized.remoteTaskGuid,
          taskSpecHash: normalized.taskSpecHash,
        }),
        normalized.expectedDraftRevision,
        normalized.at,
      ],
    );
    const presentationId = stableId("feishu-task-result", [creationId]);
    const presentationOperationKey = derivedOperationKey(
      "formal-task-result-presentation",
      [creationId],
    );
    const presentationFingerprint = operationFingerprint({
      creationId,
      proposalId: normalized.proposalId,
      groupId: draft.source_group_id,
      remoteTaskGuid: normalized.remoteTaskGuid,
    });
    await client.query(
      `INSERT INTO feishu_task_result_presentations (
         id, creation_id, proposal_id, group_id, state, operation_key,
         operation_fingerprint, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, 'pending_send', $5, $6, $7, $7)`,
      [
        presentationId,
        creationId,
        normalized.proposalId,
        draft.source_group_id,
        presentationOperationKey,
        presentationFingerprint,
        normalized.at,
      ],
    );
    await client.query(
      `INSERT INTO feishu_task_result_presentation_events (
         id, presentation_id, event_type, operation_key,
         from_version, to_version, created_at
       ) VALUES ($1, $2, 'created', $3, NULL, 1, $4)`,
      [randomUUID(), presentationId, presentationOperationKey, normalized.at],
    );
    await client.query(
      `INSERT INTO feishu_task_result_presentation_outbox (
         id, presentation_id, idempotency_key, state, created_at, updated_at
       ) VALUES ($1, $2, $3, 'pending', $4, $4)`,
      [
        stableId("feishu-task-result-outbox", [presentationId]),
        presentationId,
        `formal-task-result:${hash(presentationId)}`,
        normalized.at,
      ],
    );
  });
}

async function claimResultPresentationSend(
  dataSource: PostgresFormalTaskDataSource,
  input: Parameters<FormalTaskExecutionRepository["claimResultPresentationSend"]>[0],
): Promise<FeishuTaskResultSendClaim | undefined> {
  const workerId = requireReference("workerId", input.workerId);
  const at = requireDate(input.at);
  const leaseUntil = requireDate(input.leaseUntil);
  if (leaseUntil.getTime() <= at.getTime()) throw new Error("leaseUntil is invalid");
  return withTransaction(dataSource, async (client) => {
    await terminalizeExpiredResultAttempt(client, at);
    await terminalizeExhaustedResultSend(client, at);
    const candidate = await client.query<ResultPresentationRow & {
      attempts: string | number;
    }>(
      `${resultPresentationSelect("presentation", ", outbox.attempts")}
       JOIN feishu_task_result_presentation_outbox outbox
         ON outbox.presentation_id = presentation.id
       WHERE presentation.state = 'pending_send'
         AND (
           (outbox.state = 'pending' AND (outbox.retry_at IS NULL OR outbox.retry_at <= $1))
           OR (outbox.state = 'processing' AND outbox.lease_until < $1)
         )
         AND outbox.attempts < 5
       ORDER BY COALESCE(outbox.retry_at, outbox.created_at) ASC, outbox.id ASC
       FOR UPDATE OF presentation, outbox SKIP LOCKED LIMIT 1`,
      [at],
    );
    const row = candidate.rows[0];
    if (row === undefined) return undefined;
    const updated = await client.query<{ attempts: string | number }>(
      `UPDATE feishu_task_result_presentation_outbox
       SET state = 'processing', attempts = attempts + 1, worker_id = $2,
           lease_until = $3, retry_at = NULL, error_code = NULL, updated_at = $4
       WHERE presentation_id = $1
       RETURNING attempts`,
      [row.id, workerId, leaseUntil, at],
    );
    return {
      presentation: mapResultPresentation(row),
      workerId,
      leaseUntil,
      attempts: Number(updated.rows[0]?.attempts),
    };
  });
}

async function getResultPresentationContext(
  dataSource: PostgresFormalTaskDataSource,
  presentationId: string,
): Promise<FeishuTaskResultPresentationContext | undefined> {
  const id = requireReference("presentationId", presentationId);
  const result = await dataSource.query<ResultPresentationRow & {
    creation_proposal_id: string;
    execution_id: string;
    draft_id: string;
    draft_revision: string | number;
    draft_version: string | number;
    source_group_id: string;
    title: string;
    assignee_open_id: string;
    due_at: Date | null;
    reminder_minutes: string | number | null;
    remote_task_guid: string;
    remote_task_id: string;
    remote_task_url: string;
    task_spec_hash: string;
    completed_at: Date;
  }>(
    `${resultPresentationSelect("presentation", `,
            creation.proposal_id AS creation_proposal_id, creation.execution_id,
            creation.draft_id, creation.draft_revision, creation.draft_version,
            draft.source_group_id, revision.title, creation.assignee_open_id,
            creation.due_at, creation.reminder_minutes, creation.remote_task_guid,
            creation.remote_task_id, creation.remote_task_url, creation.task_spec_hash,
            creation.completed_at`)}
     JOIN feishu_task_creations creation ON creation.id = presentation.creation_id
     JOIN formal_task_drafts draft ON draft.id = creation.draft_id
     JOIN formal_task_draft_revisions revision
       ON revision.draft_id = creation.draft_id
      AND revision.revision_number = creation.draft_revision
     WHERE presentation.id = $1`,
    [id],
  );
  const row = result.rows[0];
  if (row === undefined) return undefined;
  const creation: FeishuTaskCreation = {
    id: row.creation_id,
    proposalId: row.creation_proposal_id,
    executionId: row.execution_id,
    draftId: row.draft_id,
    draftRevision: Number(row.draft_revision),
    draftVersion: Number(row.draft_version),
    sourceGroupId: row.source_group_id,
    title: row.title,
    assigneeOpenId: row.assignee_open_id,
    ...(row.due_at === null ? {} : { dueAt: requireDate(row.due_at) }),
    ...(row.reminder_minutes === null
      ? {}
      : { reminderMinutes: Number(row.reminder_minutes) as 0 | 30 | 60 | 1440 }),
    remoteTaskGuid: row.remote_task_guid,
    remoteTaskId: row.remote_task_id,
    remoteTaskUrl: row.remote_task_url,
    taskSpecHash: row.task_spec_hash,
    completedAt: requireDate(row.completed_at),
  };
  return { presentation: mapResultPresentation(row), creation };
}

async function beginResultPresentationAttempt(
  dataSource: PostgresFormalTaskDataSource,
  input: Parameters<FormalTaskExecutionRepository["beginResultPresentationAttempt"]>[0],
): Promise<void> {
  const normalized = normalizeResultDeliveryMutation(input);
  await withTransaction(dataSource, async (client) => {
    const presentation = await lockResultPresentation(client, normalized.presentationId);
    const outbox = await lockResultOutbox(client, normalized.presentationId);
    if (
      presentation.state !== "pending_send" || outbox.state !== "processing" ||
      outbox.worker_id !== normalized.workerId || outbox.lease_until === null ||
      outbox.lease_until.getTime() < normalized.at.getTime()
    ) throw new FormalTaskExecutionPersistenceConflictError();
    await client.query(
      `UPDATE feishu_task_result_presentation_outbox
       SET state = 'external_attempting', updated_at = $3
       WHERE presentation_id = $1 AND worker_id = $2 AND state = 'processing'`,
      [normalized.presentationId, normalized.workerId, normalized.at],
    );
  });
}

async function failResultPresentationPreparation(
  dataSource: PostgresFormalTaskDataSource,
  input: Parameters<FormalTaskExecutionRepository["failResultPresentationPreparation"]>[0],
): Promise<void> {
  const normalized = {
    ...normalizeResultDeliveryMutation(input),
    errorCode: requireReference("errorCode", input.errorCode),
  };
  await withTransaction(dataSource, async (client) => {
    const presentation = await lockResultPresentation(client, normalized.presentationId);
    const outbox = await lockResultOutbox(client, normalized.presentationId);
    if (
      presentation.state !== "pending_send" || outbox.state !== "processing" ||
      outbox.worker_id !== normalized.workerId
    ) throw new FormalTaskExecutionPersistenceConflictError();
    await terminalizeResultPresentation(client, {
      presentation,
      state: "failed",
      eventType: "send_failed",
      errorCode: normalized.errorCode,
      at: normalized.at,
    });
    await client.query(
      `UPDATE feishu_task_result_presentation_outbox
       SET state = 'failed', worker_id = NULL, lease_until = NULL, retry_at = NULL,
           error_code = $3, updated_at = $4
       WHERE presentation_id = $1 AND worker_id = $2 AND state = 'processing'`,
      [normalized.presentationId, normalized.workerId, normalized.errorCode, normalized.at],
    );
  });
}

async function completeResultPresentationSend(
  dataSource: PostgresFormalTaskDataSource,
  input: Parameters<FormalTaskExecutionRepository["completeResultPresentationSend"]>[0],
): Promise<void> {
  const normalized = {
    ...normalizeResultDeliveryMutation(input),
    messageId: requireReference("messageId", input.messageId),
  };
  await withTransaction(dataSource, async (client) => {
    const presentation = await lockResultPresentation(client, normalized.presentationId);
    const outbox = await lockResultOutbox(client, normalized.presentationId);
    if (
      presentation.state === "sent" && presentation.message_id === normalized.messageId &&
      outbox.state === "sent"
    ) return;
    if (
      presentation.state !== "pending_send" || outbox.state !== "external_attempting" ||
      outbox.worker_id !== normalized.workerId
    ) throw new FormalTaskExecutionPersistenceConflictError();
    const fromVersion = Number(presentation.version);
    await client.query(
      `UPDATE feishu_task_result_presentations
       SET state = 'sent', message_id = $2, sent_at = $3,
           version = version + 1, updated_at = $3
       WHERE id = $1 AND state = 'pending_send' AND version = $4`,
      [normalized.presentationId, normalized.messageId, normalized.at, fromVersion],
    );
    await insertResultPresentationEvent(client, {
      presentationId: normalized.presentationId,
      eventType: "send_succeeded",
      fromVersion,
      toVersion: fromVersion + 1,
      operationKey: derivedOperationKey("formal-task-result-send-succeeded", [
        normalized.presentationId,
        normalized.messageId,
      ]),
      at: normalized.at,
    });
    await client.query(
      `UPDATE feishu_task_result_presentation_outbox
       SET state = 'sent', worker_id = NULL, lease_until = NULL, retry_at = NULL,
           error_code = NULL, updated_at = $3
       WHERE presentation_id = $1 AND worker_id = $2 AND state = 'external_attempting'`,
      [normalized.presentationId, normalized.workerId, normalized.at],
    );
  });
}

async function failResultPresentationSend(
  dataSource: PostgresFormalTaskDataSource,
  input: Parameters<FormalTaskExecutionRepository["failResultPresentationSend"]>[0],
): Promise<void> {
  if (!(input.classification === "retryable" || input.classification === "permanent" ||
    input.classification === "outcome_unknown")) throw new Error("classification is invalid");
  const normalized = {
    ...normalizeResultDeliveryMutation(input),
    classification: input.classification,
    errorCode: requireReference("errorCode", input.errorCode),
    ...(input.retryAt === undefined ? {} : { retryAt: requireDate(input.retryAt) }),
  };
  if (
    (normalized.classification === "retryable") !== (normalized.retryAt !== undefined) ||
    (normalized.retryAt !== undefined && normalized.retryAt.getTime() <= normalized.at.getTime())
  ) throw new Error("retryAt is invalid");
  await withTransaction(dataSource, async (client) => {
    const presentation = await lockResultPresentation(client, normalized.presentationId);
    const outbox = await lockResultOutbox(client, normalized.presentationId);
    if (outbox.state !== "external_attempting" || outbox.worker_id !== normalized.workerId) {
      throw new FormalTaskExecutionPersistenceConflictError();
    }
    if (normalized.classification !== "retryable") {
      await terminalizeResultPresentation(client, {
        presentation,
        state: normalized.classification === "permanent" ? "failed" : "outcome_unknown",
        eventType: normalized.classification === "permanent" ? "send_failed" : "outcome_unknown",
        errorCode: normalized.errorCode,
        at: normalized.at,
      });
    }
    const state = normalized.classification === "retryable"
      ? "pending"
      : normalized.classification === "permanent" ? "failed" : "outcome_unknown";
    await client.query(
      `UPDATE feishu_task_result_presentation_outbox
       SET state = $3, worker_id = NULL, lease_until = NULL, retry_at = $4,
           error_code = $5, updated_at = $6
       WHERE presentation_id = $1 AND worker_id = $2 AND state = 'external_attempting'`,
      [
        normalized.presentationId,
        normalized.workerId,
        state,
        normalized.retryAt ?? null,
        normalized.errorCode,
        normalized.at,
      ],
    );
  });
}

async function terminalizeExpiredResultAttempt(client: TransactionClient, at: Date): Promise<void> {
  const expired = await client.query<ResultPresentationRow>(
    `${resultPresentationSelect("presentation")}
     JOIN feishu_task_result_presentation_outbox outbox
       ON outbox.presentation_id = presentation.id
     WHERE presentation.state = 'pending_send'
       AND outbox.state = 'external_attempting' AND outbox.lease_until < $1
     ORDER BY outbox.lease_until ASC, outbox.id ASC
     FOR UPDATE OF presentation, outbox SKIP LOCKED LIMIT 1`,
    [at],
  );
  const presentation = expired.rows[0];
  if (presentation === undefined) return;
  await terminalizeResultPresentation(client, {
    presentation,
    state: "outcome_unknown",
    eventType: "outcome_unknown",
    errorCode: "external_attempt_lease_expired",
    at,
  });
  await client.query(
    `UPDATE feishu_task_result_presentation_outbox
     SET state = 'outcome_unknown', worker_id = NULL, lease_until = NULL,
         retry_at = NULL, error_code = 'external_attempt_lease_expired', updated_at = $2
     WHERE presentation_id = $1 AND state = 'external_attempting'`,
    [presentation.id, at],
  );
}

async function terminalizeExhaustedResultSend(client: TransactionClient, at: Date): Promise<void> {
  const exhausted = await client.query<ResultPresentationRow>(
    `${resultPresentationSelect("presentation")}
     JOIN feishu_task_result_presentation_outbox outbox
       ON outbox.presentation_id = presentation.id
     WHERE presentation.state = 'pending_send' AND outbox.state = 'pending'
       AND outbox.attempts >= 5
     ORDER BY outbox.created_at ASC, outbox.id ASC
     FOR UPDATE OF presentation, outbox SKIP LOCKED LIMIT 1`,
  );
  const presentation = exhausted.rows[0];
  if (presentation === undefined) return;
  await terminalizeResultPresentation(client, {
    presentation,
    state: "failed",
    eventType: "send_failed",
    errorCode: "max_attempts_exhausted",
    at,
  });
  await client.query(
    `UPDATE feishu_task_result_presentation_outbox
     SET state = 'failed', worker_id = NULL, lease_until = NULL,
         retry_at = NULL, error_code = 'max_attempts_exhausted', updated_at = $2
     WHERE presentation_id = $1 AND state = 'pending'`,
    [presentation.id, at],
  );
}

async function terminalizeResultPresentation(
  client: TransactionClient,
  input: {
    presentation: ResultPresentationRow;
    state: "failed" | "outcome_unknown";
    eventType: "send_failed" | "outcome_unknown";
    errorCode: string;
    at: Date;
  },
): Promise<void> {
  if (input.presentation.state !== "pending_send") {
    throw new FormalTaskExecutionPersistenceConflictError();
  }
  const fromVersion = Number(input.presentation.version);
  await client.query(
    `UPDATE feishu_task_result_presentations
     SET state = $2, version = version + 1, updated_at = $3
     WHERE id = $1 AND state = 'pending_send' AND version = $4`,
    [input.presentation.id, input.state, input.at, fromVersion],
  );
  await insertResultPresentationEvent(client, {
    presentationId: input.presentation.id,
    eventType: input.eventType,
    operationKey: derivedOperationKey(`formal-task-result-${input.eventType}`, [
      input.presentation.id,
      fromVersion,
      input.errorCode,
    ]),
    fromVersion,
    toVersion: fromVersion + 1,
    responseClassification: input.errorCode,
    at: input.at,
  });
}

async function insertResultPresentationEvent(
  client: TransactionClient,
  input: {
    presentationId: string;
    eventType: "send_succeeded" | "send_failed" | "outcome_unknown";
    operationKey: string;
    fromVersion: number;
    toVersion: number;
    responseClassification?: string;
    at: Date;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO feishu_task_result_presentation_events (
       id, presentation_id, event_type, operation_key, from_version, to_version,
       response_classification, created_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      randomUUID(),
      input.presentationId,
      input.eventType,
      input.operationKey,
      input.fromVersion,
      input.toVersion,
      input.responseClassification ?? null,
      input.at,
    ],
  );
}

async function lockRetryCandidate(
  client: TransactionClient,
  gate: FeishuTaskCreationRuntimeGate,
  at: Date,
): Promise<ExecutionRow | undefined> {
  const result = await client.query<ExecutionRow>(
    `${executionSelect("execution")}
     JOIN action_proposals proposal ON proposal.id = execution.proposal_id
     JOIN formal_task_drafts draft ON draft.id = execution.draft_id
     JOIN formal_task_draft_revisions revision
       ON revision.draft_id = execution.draft_id
      AND revision.revision_number = execution.draft_revision
     JOIN feishu_task_target_policies policy ON policy.id = execution.target_policy_id
     WHERE execution.state = 'failed' AND execution.retry_at <= $1
       AND proposal.status = 'executing'
       AND NOT EXISTS (
         SELECT 1 FROM feishu_task_creation_executions newer
         WHERE newer.proposal_id = execution.proposal_id
           AND newer.attempt_number > execution.attempt_number
       )
       AND ${currentBindingPredicate()}
       AND draft.source_group_id = ANY($2::text[])
       AND NOT (draft.source_group_id = ANY($3::text[]))
     ORDER BY execution.retry_at ASC, execution.created_at ASC, execution.id ASC
     FOR UPDATE OF execution, proposal SKIP LOCKED LIMIT 1`,
    [at, gate.allowedGroupIds, gate.disabledGroupIds],
  );
  return result.rows[0];
}

async function lockApprovedCandidate(
  client: TransactionClient,
  gate: FeishuTaskCreationRuntimeGate,
  at: Date,
): Promise<{
  proposal_id: string;
  proposal_version: string | number;
  approval_id: string;
  draft_id: string;
  draft_revision: string | number;
  draft_version: string | number;
  title: string;
  description: string;
  assignee_open_id: string;
  due_at: Date | null;
  reminder_minutes: string | number | null;
  task_spec_hash: string;
  target_policy_id: string;
  target_policy_version: string | number;
}> {
  const result = await client.query<{
    proposal_id: string;
    proposal_version: string | number;
    approval_id: string;
    draft_id: string;
    draft_revision: string | number;
    draft_version: string | number;
    title: string;
    description: string;
    assignee_open_id: string;
    due_at: Date | null;
    reminder_minutes: string | number | null;
    task_spec_hash: string;
    target_policy_id: string;
    target_policy_version: string | number;
  }>(
    `SELECT proposal.id AS proposal_id, proposal.version AS proposal_version,
            approval.id AS approval_id, draft.id AS draft_id,
            draft.current_revision_number AS draft_revision,
            draft.version AS draft_version, revision.title, revision.description,
            revision.assignee_open_id, revision.due_at, revision.reminder_minutes,
            revision.task_spec_hash, policy.id AS target_policy_id,
            policy.version AS target_policy_version
     FROM action_proposals proposal
     JOIN formal_task_drafts draft ON draft.id = proposal.task_draft_id
     JOIN formal_task_draft_revisions revision
       ON revision.draft_id = draft.id
      AND revision.revision_number = draft.current_revision_number
     JOIN feishu_task_target_policies policy ON policy.id = proposal.task_target_policy_id
     JOIN action_approval_requirements requirement
       ON requirement.proposal_id = proposal.id
      AND requirement.requirement_kind = 'designated_owner'
      AND requirement.state = 'satisfied'
     JOIN action_approvals approval
       ON approval.proposal_id = proposal.id
      AND approval.requirement_id = requirement.id
      AND approval.actor_open_id = revision.assignee_open_id
      AND approval.subject_revision = draft.current_revision_number
      AND approval.subject_version = draft.version
     WHERE proposal.action_type = 'create_feishu_task'
       AND proposal.subject_type = 'formal_task_draft'
       AND proposal.status = 'approved'
       AND ${currentBindingPredicate()}
       AND requirement.role_ref_type = 'feishu_user'
       AND requirement.role_ref = revision.assignee_open_id
       AND requirement.task_target_policy_id = policy.id
       AND requirement.task_target_policy_version = policy.version
       AND requirement.satisfied_actor_open_id = revision.assignee_open_id
       AND requirement.satisfied_source_type = 'action_approval'
       AND requirement.satisfied_source_id = approval.id
       AND EXISTS (
         SELECT 1 FROM formal_task_draft_presentation_events confirmation
         WHERE confirmation.presentation_id = proposal.task_group_confirmation_presentation_id
           AND confirmation.event_type = 'confirmed'
       )
       AND EXISTS (
         SELECT 1 FROM action_review_attestations attestation
         WHERE attestation.proposal_id = proposal.id
           AND attestation.actor_open_id = revision.assignee_open_id
           AND attestation.subject_revision = draft.current_revision_number
           AND attestation.subject_version = draft.version
           AND attestation.content_hash = revision.task_spec_hash
       )
       AND draft.source_group_id = ANY($2::text[])
       AND NOT (draft.source_group_id = ANY($3::text[]))
       AND (revision.due_at IS NULL OR (
         revision.due_at >= $1
         AND revision.due_at <= $1 + policy.max_due_horizon_days * INTERVAL '1 day'
       ))
     ORDER BY proposal.updated_at ASC, proposal.id ASC
     FOR UPDATE OF proposal SKIP LOCKED LIMIT 1`,
    [at, gate.allowedGroupIds, gate.disabledGroupIds],
  );
  return result.rows[0] as ReturnType<typeof Promise.resolve> extends Promise<infer _> ? typeof result.rows[number] : never;
}

function currentBindingPredicate(): string {
  return `draft.status = 'pending_review'
    AND proposal.task_draft_id = draft.id
    AND proposal.task_draft_revision = draft.current_revision_number
    AND proposal.task_draft_version = draft.version
    AND proposal.task_assignee_open_id = revision.assignee_open_id
    AND proposal.task_due_at IS NOT DISTINCT FROM revision.due_at
    AND proposal.task_reminder_minutes IS NOT DISTINCT FROM revision.reminder_minutes
    AND proposal.task_spec_hash = revision.task_spec_hash
    AND proposal.task_target_policy_id = policy.id
    AND proposal.task_target_policy_version = policy.version
    AND revision.target_policy_id = policy.id
    AND revision.target_policy_version = policy.version
    AND policy.enabled = TRUE
    AND policy.source_group_id = draft.source_group_id
    AND revision.assignee_open_id = ANY(policy.allowed_assignee_open_ids)`;
}

async function insertExecution(
  client: TransactionClient,
  input: {
    id: string;
    proposalId: string;
    approvalId: string;
    draftId: string;
    draftRevision: number;
    draftVersion: number;
    targetPolicyId: string;
    targetPolicyVersion: number;
    assigneeOpenId: string;
    attemptNumber: number;
    requestFingerprint: string;
    clientTokenHash: string;
    operationKey: string;
    workerId: string;
    leaseUntil: Date;
    at: Date;
  },
): Promise<void> {
  try {
    await client.query(
      `INSERT INTO feishu_task_creation_executions (
         id, proposal_id, approval_id, draft_id, draft_revision, draft_version,
         target_policy_id, target_policy_version, assignee_open_id, attempt_number,
         state, request_fingerprint, client_token_hash, operation_key,
         worker_id, lease_until, created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
         'claimed', $11, $12, $13, $14, $15, $16, $16
       )`,
      [
        input.id,
        input.proposalId,
        input.approvalId,
        input.draftId,
        input.draftRevision,
        input.draftVersion,
        input.targetPolicyId,
        input.targetPolicyVersion,
        input.assigneeOpenId,
        input.attemptNumber,
        input.requestFingerprint,
        input.clientTokenHash,
        input.operationKey,
        input.workerId,
        input.leaseUntil,
        input.at,
      ],
    );
    await insertExecutionEvent(client, {
      executionId: input.id,
      eventType: "claimed",
      operationKey: input.operationKey,
      toVersion: 1,
      at: input.at,
    });
  } catch (error) {
    if (isConstraintConflict(error)) throw new FormalTaskExecutionPersistenceConflictError();
    throw error;
  }
}

async function loadClaim(
  client: Pick<TransactionClient, "query">,
  executionId: string,
): Promise<ClaimedFeishuTaskCreation | undefined> {
  const result = await client.query<ClaimRow>(
    `${executionSelect("execution", `, proposal.version AS proposal_version,
            revision.title, revision.description, draft.source_group_id,
            revision.due_at, revision.reminder_minutes, revision.task_spec_hash,
            policy.id AS policy_id, policy.version AS policy_version`)}
     JOIN action_proposals proposal ON proposal.id = execution.proposal_id
     JOIN formal_task_drafts draft ON draft.id = execution.draft_id
     JOIN formal_task_draft_revisions revision
       ON revision.draft_id = execution.draft_id
      AND revision.revision_number = execution.draft_revision
     JOIN feishu_task_target_policies policy ON policy.id = execution.target_policy_id
     WHERE execution.id = $1`,
    [executionId],
  );
  const row = result.rows[0];
  if (row === undefined) return undefined;
  const clientToken = createClientToken(row.proposal_id, row.task_spec_hash);
  if (hash(clientToken) !== row.client_token_hash) {
    throw new FormalTaskExecutionPersistenceConflictError();
  }
  const expectedFingerprint = createRequestFingerprint({
    proposalId: row.proposal_id,
    draftId: row.draft_id,
    draftRevision: Number(row.draft_revision),
    draftVersion: Number(row.draft_version),
    title: row.title,
    description: row.description,
    assigneeOpenId: row.assignee_open_id,
    dueAt: row.due_at,
    reminderMinutes: row.reminder_minutes === null ? undefined : Number(row.reminder_minutes),
    taskSpecHash: row.task_spec_hash,
    targetPolicyId: row.policy_id,
    targetPolicyVersion: Number(row.policy_version),
    clientToken,
  });
  if (expectedFingerprint !== row.request_fingerprint) {
    throw new FormalTaskExecutionPersistenceConflictError();
  }
  return {
    proposal: { id: row.proposal_id, version: Number(row.proposal_version) },
    approvalId: row.approval_id,
    execution: mapExecution(row),
    draft: {
      id: row.draft_id,
      revision: Number(row.draft_revision),
      version: Number(row.draft_version),
      sourceGroupId: row.source_group_id,
      title: row.title,
      description: row.description,
      assigneeOpenId: row.assignee_open_id,
      ...(row.due_at === null ? {} : { dueAt: requireDate(row.due_at) }),
      ...(row.reminder_minutes === null
        ? {}
        : { reminderMinutes: Number(row.reminder_minutes) as 0 | 30 | 60 | 1440 }),
      taskSpecHash: row.task_spec_hash,
    },
    policy: { id: row.policy_id, version: Number(row.policy_version) },
    clientToken,
  };
}

function executionSelect(alias: string, extraColumns = ""): string {
  return `SELECT ${alias}.id, ${alias}.proposal_id, ${alias}.approval_id,
    ${alias}.draft_id, ${alias}.draft_revision, ${alias}.draft_version,
    ${alias}.target_policy_id, ${alias}.target_policy_version,
    ${alias}.assignee_open_id, ${alias}.attempt_number, ${alias}.state,
    ${alias}.request_fingerprint, ${alias}.client_token_hash, ${alias}.operation_key,
    ${alias}.response_classification, ${alias}.remote_task_guid,
    ${alias}.remote_task_id, ${alias}.remote_task_url, ${alias}.worker_id,
    ${alias}.lease_until, ${alias}.retry_at, ${alias}.version,
    ${alias}.dispatched_at, ${alias}.created_at, ${alias}.updated_at${extraColumns}
    FROM feishu_task_creation_executions ${alias}`;
}

function resultPresentationSelect(alias: string, extraColumns = ""): string {
  return `SELECT ${alias}.id, ${alias}.creation_id, ${alias}.proposal_id,
    ${alias}.group_id, ${alias}.state, ${alias}.message_id, ${alias}.operation_key,
    ${alias}.operation_fingerprint, ${alias}.version, ${alias}.created_at,
    ${alias}.sent_at, ${alias}.updated_at${extraColumns}
    FROM feishu_task_result_presentations ${alias}`;
}

async function lockResultPresentation(
  client: TransactionClient,
  id: string,
): Promise<ResultPresentationRow> {
  const result = await client.query<ResultPresentationRow>(
    `${resultPresentationSelect("presentation")} WHERE presentation.id = $1 FOR UPDATE`,
    [id],
  );
  if (result.rows[0] === undefined) throw new FormalTaskExecutionPersistenceConflictError();
  return result.rows[0];
}

async function lockResultOutbox(
  client: TransactionClient,
  presentationId: string,
): Promise<ResultOutboxRow> {
  const result = await client.query<ResultOutboxRow>(
    `SELECT id, presentation_id, state, attempts, worker_id, lease_until,
            retry_at, error_code
     FROM feishu_task_result_presentation_outbox
     WHERE presentation_id = $1 FOR UPDATE`,
    [presentationId],
  );
  if (result.rows[0] === undefined) throw new FormalTaskExecutionPersistenceConflictError();
  return result.rows[0];
}

function mapResultPresentation(row: ResultPresentationRow): FeishuTaskResultPresentation {
  return {
    id: row.id,
    creationId: row.creation_id,
    proposalId: row.proposal_id,
    groupId: row.group_id,
    state: row.state,
    ...(row.message_id === null ? {} : { messageId: row.message_id }),
    version: Number(row.version),
    createdAt: requireDate(row.created_at),
    ...(row.sent_at === null ? {} : { sentAt: requireDate(row.sent_at) }),
  };
}

function normalizeResultDeliveryMutation(input: {
  presentationId: string;
  workerId: string;
  at: Date;
}) {
  return {
    presentationId: requireReference("presentationId", input.presentationId),
    workerId: requireReference("workerId", input.workerId),
    at: requireDate(input.at),
  };
}

async function lockExecution(client: TransactionClient, id: string): Promise<ExecutionRow> {
  const result = await client.query<ExecutionRow>(
    `${executionSelect("execution")} WHERE execution.id = $1 FOR UPDATE`,
    [id],
  );
  if (result.rows[0] === undefined) throw new FormalTaskExecutionPersistenceConflictError();
  return result.rows[0];
}

async function lockProposal(client: TransactionClient, id: string): Promise<{
  id: string;
  status: string;
  version: string | number;
}> {
  const result = await client.query<{ id: string; status: string; version: string | number }>(
    "SELECT id, status, version FROM action_proposals WHERE id = $1 FOR UPDATE",
    [id],
  );
  if (result.rows[0] === undefined) throw new FormalTaskExecutionPersistenceConflictError();
  return result.rows[0];
}

async function insertExecutionEvent(
  client: TransactionClient,
  input: {
    executionId: string;
    eventType: "claimed" | "request_dispatched" | "succeeded" | "failed" |
      "outcome_unknown" | "reconciliation_required";
    operationKey: string;
    fromVersion?: number;
    toVersion: number;
    responseClassification?: string;
    at: Date;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO feishu_task_creation_execution_events (
       id, execution_id, event_type, operation_key, from_version, to_version,
       response_classification, created_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      randomUUID(),
      input.executionId,
      input.eventType,
      input.operationKey,
      input.fromVersion ?? null,
      input.toVersion,
      input.responseClassification ?? null,
      input.at,
    ],
  );
}

function mapExecution(row: ExecutionRow): FeishuTaskCreationExecution {
  return {
    id: row.id,
    proposalId: row.proposal_id,
    state: row.state,
    attemptNumber: Number(row.attempt_number),
    version: Number(row.version),
    requestFingerprint: row.request_fingerprint,
    clientTokenHash: row.client_token_hash,
    ...(row.response_classification === null
      ? {}
      : { responseClassification: row.response_classification }),
    ...(row.remote_task_guid === null ? {} : { remoteTaskGuid: row.remote_task_guid }),
    ...(row.remote_task_id === null ? {} : { remoteTaskId: row.remote_task_id }),
    ...(row.remote_task_url === null ? {} : { remoteTaskUrl: row.remote_task_url }),
    ...(row.worker_id === null ? {} : { workerId: row.worker_id }),
    ...(row.lease_until === null ? {} : { leaseUntil: requireDate(row.lease_until) }),
    ...(row.retry_at === null ? {} : { retryAt: requireDate(row.retry_at) }),
    ...(row.dispatched_at === null ? {} : { dispatchedAt: requireDate(row.dispatched_at) }),
    createdAt: requireDate(row.created_at),
    updatedAt: requireDate(row.updated_at),
  };
}

function mapExecutionMetadata(row: ExecutionMetadataRow): FormalTaskExecutionMetadata {
  return {
    id: row.id,
    proposalId: row.proposal_id,
    draftId: row.draft_id,
    draftRevision: Number(row.draft_revision),
    draftVersion: Number(row.draft_version),
    targetPolicyId: row.target_policy_id,
    targetPolicyVersion: Number(row.target_policy_version),
    attemptNumber: Number(row.attempt_number),
    state: row.state,
    requestFingerprint: row.request_fingerprint,
    clientTokenHash: row.client_token_hash,
    ...(row.response_classification === null
      ? {}
      : { responseClassification: row.response_classification }),
    version: Number(row.version),
    ...(row.lease_until === null ? {} : { leaseUntil: requireDate(row.lease_until) }),
    ...(row.retry_at === null ? {} : { retryAt: requireDate(row.retry_at) }),
    ...(row.dispatched_at === null ? {} : { dispatchedAt: requireDate(row.dispatched_at) }),
    createdAt: requireDate(row.created_at),
    updatedAt: requireDate(row.updated_at),
  };
}

function mapCounts<State extends string>(
  states: readonly State[],
  rows: readonly { state: State; count: string | number }[],
): Record<State, number> {
  const counts = Object.fromEntries(states.map((state) => [state, 0])) as Record<State, number>;
  for (const row of rows) {
    if (!states.includes(row.state)) throw new FormalTaskExecutionPersistenceConflictError();
    const count = typeof row.count === "number" ? row.count : Number(row.count);
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new FormalTaskExecutionPersistenceConflictError();
    }
    counts[row.state] = count;
  }
  return counts;
}

function normalizeExecutionStates(
  value: FeishuTaskCreationExecution["state"][],
): FeishuTaskCreationExecution["state"][] {
  const allowed: FeishuTaskCreationExecution["state"][] = [
    "claimed", "external_attempting", "succeeded", "failed", "outcome_unknown",
    "reconciliation_required",
  ];
  if (
    !Array.isArray(value) || value.length < 1 || value.length > allowed.length ||
    value.some((state) => !allowed.includes(state)) || new Set(value).size !== value.length
  ) throw new Error("states is invalid");
  return [...value];
}

function normalizeClaim(input: Parameters<FormalTaskExecutionRepository["claimNextCreation"]>[0]) {
  const at = requireDate(input.at);
  const leaseUntil = requireDate(input.leaseUntil);
  if (leaseUntil.getTime() <= at.getTime()) throw new Error("leaseUntil is invalid");
  return {
    runtimeGate: normalizeRuntimeGate(input.runtimeGate),
    workerId: requireReference("workerId", input.workerId),
    leaseUntil,
    operationKey: requireReference("operationKey", input.operationKey),
    at,
  };
}

function normalizeRuntimeGate(value: FeishuTaskCreationRuntimeGate): FeishuTaskCreationRuntimeGate {
  if (
    typeof value !== "object" || value === null ||
    typeof value.deploymentEnabled !== "boolean" ||
    typeof value.globalEnabled !== "boolean" ||
    typeof value.createFeishuTasks !== "boolean" ||
    typeof value.callExternalTools !== "boolean"
  ) throw new Error("runtimeGate is invalid");
  return {
    deploymentEnabled: value.deploymentEnabled,
    globalEnabled: value.globalEnabled,
    createFeishuTasks: value.createFeishuTasks,
    callExternalTools: value.callExternalTools,
    disabledGroupIds: requireReferenceList("disabledGroupIds", value.disabledGroupIds),
    allowedGroupIds: requireReferenceList("allowedGroupIds", value.allowedGroupIds),
  };
}

function canClaim(value: FeishuTaskCreationRuntimeGate): boolean {
  return value.deploymentEnabled && value.globalEnabled && value.createFeishuTasks &&
    value.callExternalTools && value.allowedGroupIds.length > 0;
}

function normalizeFailure(input: RecordFeishuTaskCreationFailureInput) {
  if (!(["retryable", "failed", "outcome_unknown", "reconciliation_required"] as const)
    .includes(input.classification)) throw new Error("classification is invalid");
  const at = requireDate(input.at);
  const retryAt = input.retryAt === undefined ? undefined : requireDate(input.retryAt);
  if (
    (input.classification === "retryable" || input.classification === "outcome_unknown") !==
      (retryAt !== undefined) ||
    (retryAt !== undefined && retryAt.getTime() <= at.getTime())
  ) throw new Error("retryAt is invalid");
  const remoteValues = [input.remoteTaskGuid, input.remoteTaskId, input.remoteTaskUrl];
  if (remoteValues.some((value) => value !== undefined) &&
    remoteValues.some((value) => value === undefined)) throw new Error("remote identity is invalid");
  return {
    proposalId: requireReference("proposalId", input.proposalId),
    executionId: requireReference("executionId", input.executionId),
    expectedProposalVersion: requirePositiveInteger(
      "expectedProposalVersion",
      input.expectedProposalVersion,
    ),
    expectedExecutionVersion: requirePositiveInteger(
      "expectedExecutionVersion",
      input.expectedExecutionVersion,
    ),
    classification: input.classification,
    responseClassification: requireReference(
      "responseClassification",
      input.responseClassification,
    ),
    ...(retryAt === undefined ? {} : { retryAt }),
    ...(input.remoteTaskGuid === undefined
      ? {}
      : {
          remoteTaskGuid: requireReference("remoteTaskGuid", input.remoteTaskGuid),
          remoteTaskId: requireReference("remoteTaskId", input.remoteTaskId),
          remoteTaskUrl: requireTaskUrl(input.remoteTaskUrl),
        }),
    operationKey: requireReference("operationKey", input.operationKey),
    at,
  };
}

function normalizeComplete(input: CompleteFeishuTaskCreationInput) {
  return {
    proposalId: requireReference("proposalId", input.proposalId),
    executionId: requireReference("executionId", input.executionId),
    expectedProposalVersion: requirePositiveInteger(
      "expectedProposalVersion",
      input.expectedProposalVersion,
    ),
    expectedExecutionVersion: requirePositiveInteger(
      "expectedExecutionVersion",
      input.expectedExecutionVersion,
    ),
    expectedDraftVersion: requirePositiveInteger("expectedDraftVersion", input.expectedDraftVersion),
    expectedDraftRevision: requirePositiveInteger(
      "expectedDraftRevision",
      input.expectedDraftRevision,
    ),
    taskSpecHash: requireHash("taskSpecHash", input.taskSpecHash),
    remoteTaskGuid: requireReference("remoteTaskGuid", input.remoteTaskGuid),
    remoteTaskId: requireReference("remoteTaskId", input.remoteTaskId),
    remoteTaskUrl: requireTaskUrl(input.remoteTaskUrl),
    operationKey: requireReference("operationKey", input.operationKey),
    at: requireDate(input.at),
  };
}

function createClientToken(proposalId: string, taskSpecHash: string): string {
  return `iris-task-${hash(JSON.stringify([proposalId, taskSpecHash])).slice(0, 32)}`;
}

function createRequestFingerprint(input: {
  proposalId: string;
  draftId: string;
  draftRevision: number;
  draftVersion: number;
  title: string;
  description: string;
  assigneeOpenId: string;
  dueAt: Date | null;
  reminderMinutes?: number;
  taskSpecHash: string;
  targetPolicyId: string;
  targetPolicyVersion: number;
  clientToken: string;
}): string {
  return operationFingerprint({
    proposalId: input.proposalId,
    draftId: input.draftId,
    draftRevision: input.draftRevision,
    draftVersion: input.draftVersion,
    title: input.title,
    description: input.description,
    assigneeOpenId: input.assigneeOpenId,
    dueAt: input.dueAt?.toISOString() ?? null,
    reminderMinutes: input.reminderMinutes ?? null,
    taskSpecHash: input.taskSpecHash,
    targetPolicyId: input.targetPolicyId,
    targetPolicyVersion: input.targetPolicyVersion,
    clientToken: input.clientToken,
  });
}

function failureEventType(
  classification: RecordFeishuTaskCreationFailureInput["classification"],
): "failed" | "outcome_unknown" | "reconciliation_required" {
  return classification === "outcome_unknown"
    ? "outcome_unknown"
    : classification === "reconciliation_required" ? "reconciliation_required" : "failed";
}

function stableId(prefix: string, values: unknown[]): string {
  return `${prefix}-${hash(JSON.stringify(values)).slice(0, 40)}`;
}

function derivedOperationKey(prefix: string, values: unknown[]): string {
  return `${prefix}:${hash(JSON.stringify(values))}`;
}

function operationFingerprint(value: unknown): string {
  return hash(JSON.stringify(value));
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function requireClaim(
  value: ClaimedFeishuTaskCreation | undefined,
): ClaimedFeishuTaskCreation {
  if (value === undefined) throw new FormalTaskExecutionPersistenceConflictError();
  return value;
}

function requireTaskUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 2_048) throw new Error("remoteTaskUrl is invalid");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("remoteTaskUrl is invalid");
  }
  if (
    url.protocol !== "https:" || url.port !== "" || url.username !== "" || url.password !== "" ||
    !(url.hostname === "feishu.cn" || url.hostname.endsWith(".feishu.cn"))
  ) throw new Error("remoteTaskUrl is invalid");
  return url.toString();
}

function requireReferenceList(name: string, value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 1_000) throw new Error(`${name} is invalid`);
  const result = value.map((item) => requireReference(name, item)).sort();
  if (new Set(result).size !== result.length) throw new Error(`${name} is invalid`);
  return result;
}

function requireReference(name: string, value: unknown): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  const normalized = value.trim();
  if (
    normalized !== value || normalized.length < 1 || normalized.length > 512 ||
    /[\u0000-\u001f\u007f]/u.test(normalized)
  ) throw new Error(`${name} is invalid`);
  return normalized;
}

function requireHash(name: string, value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function requirePositiveInteger(name: string, value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new Error(`${name} is invalid`);
  return Number(value);
}

function requireIntegerBetween(
  name: string,
  value: unknown,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new Error(`${name} is invalid`);
  }
  return Number(value);
}

function requireDate(value: unknown): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error("date is invalid");
  return new Date(value);
}

function isConstraintConflict(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    ["23503", "23505", "23514"].includes(String((error as { code?: unknown }).code));
}

async function withTransaction<T>(
  dataSource: PostgresFormalTaskDataSource,
  operation: (client: TransactionClient) => Promise<T>,
): Promise<T> {
  const client = await dataSource.connect();
  try {
    await client.query("BEGIN");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Preserve the original persistence error.
    }
    throw error;
  } finally {
    client.release();
  }
}
