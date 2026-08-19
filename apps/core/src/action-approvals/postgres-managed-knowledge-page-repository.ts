import { createHash, randomUUID } from "node:crypto";

import type {
  KnowledgeDraftTransactionClient,
  PostgresKnowledgeDraftDataSource,
} from "../knowledge-governance/postgres-knowledge-draft-repository.js";

import type {
  ManagedKnowledgePage,
  ManagedKnowledgeUpdateExecution,
  ManagedKnowledgeUpdateTarget,
  ManagedSnapshotObservation,
} from "./managed-knowledge-page.js";
import { normalizeManagedKnowledgePage } from "./managed-knowledge-page.js";
import type {
  BindManagedUpdateTargetInput,
  ClaimManagedUpdateInput,
  ClaimedManagedKnowledgeUpdate,
  CompleteManagedResyncInput,
  EligibleManagedPageForConflictInput,
  LinkManagedPageSourceInput,
  MarkManagedRemoteRequestDispatchedInput,
  ManagedExecutionMutationResult,
  ManagedKnowledgePageRepository,
  ManagedPageMutationResult,
  ManagedSnapshotObservationResult,
  ManagedTargetMutationResult,
  RecordManagedRemoteOutcomeInput,
  RecordManagedSnapshotObservationInput,
  RegisterManagedPublicationInput,
} from "./managed-knowledge-page-repository.js";

export class ManagedKnowledgePageOperationConflictError extends Error {
  constructor() {
    super("managed knowledge page operation conflict");
    this.name = "ManagedKnowledgePageOperationConflictError";
  }
}

export class ManagedKnowledgePageVersionConflictError extends Error {
  constructor() {
    super("managed knowledge page version conflict");
    this.name = "ManagedKnowledgePageVersionConflictError";
  }
}

type PageRow = Record<string, unknown>;
type TargetRow = Record<string, unknown>;
type ExecutionRow = Record<string, unknown>;
type ObservationRow = Record<string, unknown>;

export function createPostgresManagedKnowledgePageRepository({
  dataSource,
}: {
  dataSource: PostgresKnowledgeDraftDataSource;
}): ManagedKnowledgePageRepository {
  return {
    registerPublication: (input) => registerPublication(dataSource, input),
    findEligiblePageForConflict: (input) => findEligiblePageForConflict(dataSource, input),
    linkSource: (input) => linkSource(dataSource, input),
    recordSnapshotObservation: (input) => recordSnapshotObservation(dataSource, input),
    bindConflictDraft: (input) => bindConflictDraft(dataSource, input),
    getTargetForDraft: (input) => getTargetForDraft(dataSource, input),
    claimApprovedUpdate: (input) => claimApprovedUpdate(dataSource, input),
    markRemoteRequestDispatched: (input) => markRemoteRequestDispatched(dataSource, input),
    recordRemoteOutcome: (input) => recordRemoteOutcome(dataSource, input),
    completeResync: (input) => completeResync(dataSource, input),
    listReconciliationRequired: (input) => listReconciliationRequired(dataSource, input),
    getSourceAvailability: (documentSourceId) => getSourceAvailability(dataSource, documentSourceId),
  };
}

async function registerPublication(
  dataSource: PostgresKnowledgeDraftDataSource,
  input: RegisterManagedPublicationInput,
): Promise<ManagedPageMutationResult> {
  const normalized = normalizeRegisterInput(input);
  const fingerprint = operationFingerprint(normalized);
  return withTransaction(dataSource, async (client) => {
    await lockOperation(client, normalized.operationKey);
    const replay = await client.query<{ managed_page_id: string; operation_fingerprint: string }>(
      `SELECT managed_page_id, operation_fingerprint FROM managed_knowledge_page_events
       WHERE operation_key = $1`, [normalized.operationKey],
    );
    if (replay.rows[0] !== undefined) {
      if (replay.rows[0].operation_fingerprint !== fingerprint) throw new ManagedKnowledgePageOperationConflictError();
      return { outcome: "already_applied", page: await requirePage(client, replay.rows[0].managed_page_id) };
    }
    const existing = await client.query<{ id: string }>(
      `SELECT id FROM managed_knowledge_pages
       WHERE origin_knowledge_publication_id = $1 OR remote_document_token = $2 FOR UPDATE`,
      [normalized.originKnowledgePublicationId, normalized.remoteDocumentToken],
    );
    if (existing.rows[0] !== undefined) throw new ManagedKnowledgePageOperationConflictError();
    await client.query(
      `INSERT INTO managed_knowledge_pages (
        id, origin_knowledge_publication_id, target_policy_id, target_policy_version, authorization_group_id,
        remote_node_token, remote_document_token, managed_body_block_id, current_remote_revision_id,
        current_body_content_hash, state, version, created_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'active',1,$11,$11)`,
      [normalized.id, normalized.originKnowledgePublicationId, normalized.targetPolicyId,
        normalized.targetPolicyVersion, normalized.authorizationGroupId, normalized.remoteNodeToken,
        normalized.remoteDocumentToken, normalized.managedBodyBlockId, normalized.currentRemoteRevisionId,
        normalized.currentBodyContentHash, normalized.at],
    );
    await insertPageEvent(client, {
      pageId: normalized.id, eventType: "registered", fromVersion: undefined, toVersion: 1,
      operationKey: normalized.operationKey, fingerprint, actor: normalized.actor, at: normalized.at,
    });
    return { outcome: "applied", page: await requirePage(client, normalized.id) };
  });
}

async function findEligiblePageForConflict(
  dataSource: PostgresKnowledgeDraftDataSource,
  input: EligibleManagedPageForConflictInput,
): Promise<ManagedKnowledgePage | undefined> {
  const result = await dataSource.query<PageRow>(`${pageSelect()} WHERE linked_document_source_id = $1
    AND authorization_group_id = $2 AND state = 'active'`, [ref("documentSourceId", input.documentSourceId), ref("authorizationGroupId", input.authorizationGroupId)]);
  return result.rows[0] === undefined ? undefined : mapPage(result.rows[0]);
}

async function linkSource(
  dataSource: PostgresKnowledgeDraftDataSource,
  input: LinkManagedPageSourceInput,
): Promise<ManagedPageMutationResult> {
  const normalized = {
    managedPageId: ref("managedPageId", input.managedPageId), expectedVersion: positive("expectedVersion", input.expectedVersion),
    documentSourceId: ref("documentSourceId", input.documentSourceId), operationKey: ref("operationKey", input.operationKey),
    actor: ref("actor", input.actor), at: date("at", input.at),
  };
  const fingerprint = operationFingerprint(normalized);
  return withTransaction(dataSource, async (client) => {
    await lockOperation(client, normalized.operationKey);
    const replay = await pageReplay(client, normalized.operationKey, fingerprint);
    if (replay !== undefined) return { outcome: "already_applied", page: replay };
    const page = await requirePageForUpdate(client, normalized.managedPageId);
    if (page.version !== normalized.expectedVersion) throw new ManagedKnowledgePageVersionConflictError();
    await client.query(`UPDATE managed_knowledge_pages SET linked_document_source_id = $2, version = version + 1,
      updated_at = $3 WHERE id = $1`, [page.id, normalized.documentSourceId, normalized.at]);
    await insertPageEvent(client, { pageId: page.id, eventType: "source_linked", fromVersion: page.version,
      toVersion: page.version + 1, operationKey: normalized.operationKey, fingerprint, actor: normalized.actor, at: normalized.at });
    return { outcome: "applied", page: await requirePage(client, page.id) };
  });
}

async function recordSnapshotObservation(
  dataSource: PostgresKnowledgeDraftDataSource,
  input: RecordManagedSnapshotObservationInput,
): Promise<ManagedSnapshotObservationResult> {
  const normalized = normalizeObservationInput(input);
  const fingerprint = operationFingerprint(normalized);
  return withTransaction(dataSource, async (client) => {
    await lockOperation(client, normalized.operationKey);
    const replay = await client.query<ObservationRow>(`${observationSelect()} WHERE operation_key = $1`, [normalized.operationKey]);
    if (replay.rows[0] !== undefined) {
      if (text(replay.rows[0].operation_fingerprint) !== fingerprint) throw new ManagedKnowledgePageOperationConflictError();
      return { outcome: "already_applied", observation: mapObservation(replay.rows[0]) };
    }
    await client.query(`INSERT INTO managed_knowledge_snapshot_observations (
      id, managed_page_id, managed_page_version, document_snapshot_id, document_source_id, snapshot_content_hash,
      observed_remote_revision_id, observed_managed_body_block_id, observed_block_type, managed_body_content_hash,
      adapter_version, operation_key, operation_fingerprint, observed_at, created_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'text',$9,$10,$11,$12,$13,$13)`,
    [normalized.id, normalized.managedPageId, normalized.managedPageVersion, normalized.documentSnapshotId,
      normalized.documentSourceId, normalized.snapshotContentHash, normalized.observedRemoteRevisionId,
      normalized.observedManagedBodyBlockId, normalized.managedBodyContentHash, normalized.adapterVersion,
      normalized.operationKey, fingerprint, normalized.at]);
    return { outcome: "applied", observation: await requireObservation(client, normalized.id) };
  });
}

async function bindConflictDraft(dataSource: PostgresKnowledgeDraftDataSource, input: BindManagedUpdateTargetInput): Promise<ManagedTargetMutationResult> {
  const normalized = normalizeTargetInput(input);
  const fingerprint = operationFingerprint(normalized);
  return withTransaction(dataSource, async (client) => {
    await lockOperation(client, normalized.operationKey);
    const replay = await client.query<TargetRow>(`${targetSelect()} WHERE operation_key = $1`, [normalized.operationKey]);
    if (replay.rows[0] !== undefined) {
      if (text(replay.rows[0].operation_fingerprint) !== fingerprint) throw new ManagedKnowledgePageOperationConflictError();
      return { outcome: "already_applied", target: mapTarget(replay.rows[0]) };
    }
    const page = await requirePageForUpdate(client, normalized.managedPageId);
    const candidate = await client.query<Record<string, unknown>>(`SELECT version, group_id, target_document_source_id, target_snapshot_id, target_content_hash, target_source_version FROM knowledge_conflict_candidates WHERE id = $1 FOR UPDATE`, [normalized.conflictCandidateId]);
    const draft = await client.query<Record<string, unknown>>(`SELECT current_revision_number, version FROM knowledge_drafts WHERE id = $1 FOR UPDATE`, [normalized.draftId]);
    const candidateRow = candidate.rows[0]; const draftRow = draft.rows[0];
    if (candidateRow === undefined || draftRow === undefined || page.state !== "active" || page.version !== normalized.managedPageVersion || page.linkedDocumentSourceId !== normalized.linkedDocumentSourceId || page.authorizationGroupId !== normalized.authorizationGroupId || page.targetPolicyId !== normalized.targetPolicyId || page.targetPolicyVersion !== normalized.targetPolicyVersion || page.remoteDocumentToken !== normalized.remoteDocumentToken || page.managedBodyBlockId !== normalized.managedBodyBlockId || page.currentRemoteRevisionId !== normalized.expectedRemoteRevisionId || page.currentBodyContentHash !== normalized.currentBodyContentHash || number(candidateRow.version) !== normalized.conflictCandidateVersion || text(candidateRow.group_id) !== normalized.authorizationGroupId || text(candidateRow.target_document_source_id) !== normalized.linkedDocumentSourceId || text(candidateRow.target_snapshot_id) !== normalized.targetSnapshotId || text(candidateRow.target_content_hash) !== normalized.targetSnapshotHash || (candidateRow.target_source_version ?? undefined) !== normalized.targetSourceVersion || number(draftRow.current_revision_number) !== normalized.draftRevision || number(draftRow.version) !== normalized.draftVersion) throw new ManagedKnowledgePageVersionConflictError();
    await client.query(`INSERT INTO knowledge_publication_update_targets (
      id,draft_id,draft_revision,draft_version,conflict_candidate_id,conflict_candidate_version,managed_page_id,
      managed_page_version,linked_document_source_id,target_snapshot_id,target_snapshot_hash,target_source_version,
      remote_document_token,managed_body_block_id,expected_remote_revision_id,current_body_content_hash,
      proposed_body_content_hash,authorization_group_id,target_policy_id,target_policy_version,operation_key,
      operation_fingerprint,created_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)`,
    [normalized.id, normalized.draftId, normalized.draftRevision, normalized.draftVersion, normalized.conflictCandidateId,
      normalized.conflictCandidateVersion, normalized.managedPageId, normalized.managedPageVersion,
      normalized.linkedDocumentSourceId, normalized.targetSnapshotId, normalized.targetSnapshotHash,
      normalized.targetSourceVersion ?? null, normalized.remoteDocumentToken, normalized.managedBodyBlockId,
      normalized.expectedRemoteRevisionId, normalized.currentBodyContentHash, normalized.proposedBodyContentHash,
      normalized.authorizationGroupId, normalized.targetPolicyId, normalized.targetPolicyVersion, normalized.operationKey,
      fingerprint, normalized.at]);
    return { outcome: "applied", target: await requireTarget(client, normalized.id) };
  });
}

async function getTargetForDraft(dataSource: PostgresKnowledgeDraftDataSource, input: { draftId: string; revision: number }): Promise<ManagedKnowledgeUpdateTarget | undefined> {
  const result = await dataSource.query<TargetRow>(`${targetSelect()} WHERE draft_id = $1 AND draft_revision = $2`,
    [ref("draftId", input.draftId), positive("revision", input.revision)]);
  return result.rows[0] === undefined ? undefined : mapTarget(result.rows[0]);
}

async function claimApprovedUpdate(dataSource: PostgresKnowledgeDraftDataSource, input: ClaimManagedUpdateInput): Promise<ClaimedManagedKnowledgeUpdate> {
  const normalized = { id: ref("id", input.id), proposalId: ref("proposalId", input.proposalId), updateTargetId: ref("updateTargetId", input.updateTargetId), expectedManagedPageVersion: positive("expectedManagedPageVersion", input.expectedManagedPageVersion), operationKey: ref("operationKey", input.operationKey), clientToken: ref("clientToken", input.clientToken), workerId: ref("workerId", input.workerId), at: date("at", input.at) };
  const fingerprint = operationFingerprint(normalized);
  return withTransaction(dataSource, async (client) => {
    await lockOperation(client, normalized.operationKey);
    const replay = await client.query<ExecutionRow>(`${executionSelect()} WHERE operation_key = $1`, [normalized.operationKey]);
    if (replay.rows[0] !== undefined) {
      if (text(replay.rows[0].operation_fingerprint) !== fingerprint) throw new ManagedKnowledgePageOperationConflictError();
      const execution = mapExecution(replay.rows[0]); const target = await requireTarget(client, execution.updateTargetId);
      return { outcome: "already_applied", page: await requirePage(client, execution.managedPageId), target, execution };
    }
    const targetIdentity = await requireTarget(client, normalized.updateTargetId);
    const page = await requirePageForUpdate(client, targetIdentity.managedPageId);
    const target = await requireTargetForUpdate(client, normalized.updateTargetId);
    const proposal = await client.query<Record<string, unknown>>(`SELECT id, action_type, subject_id, subject_revision, subject_version, target_policy_id, target_policy_version, status, version FROM action_proposals WHERE id = $1 FOR UPDATE`, [normalized.proposalId]);
    const proposalRow = proposal.rows[0];
    const requirements = await client.query<{ present: boolean }>(`SELECT NOT EXISTS (SELECT 1 FROM action_approval_requirements WHERE proposal_id = $1 AND state <> 'satisfied') AND EXISTS (SELECT 1 FROM action_review_attestations WHERE proposal_id = $1 AND proposal_version = $2 AND subject_revision = $3 AND subject_version = $4) AS present`, [normalized.proposalId, proposalRow === undefined ? 0 : number(proposalRow.version), target.draftRevision, target.draftVersion]);
    if (proposalRow === undefined || page.version !== normalized.expectedManagedPageVersion || page.state !== "active" || page.linkedDocumentSourceId !== target.linkedDocumentSourceId || text(proposalRow.action_type) !== "update_knowledge_publication" || text(proposalRow.status) !== "approved" || text(proposalRow.subject_id) !== target.draftId || number(proposalRow.subject_revision) !== target.draftRevision || number(proposalRow.subject_version) !== target.draftVersion || text(proposalRow.target_policy_id) !== target.targetPolicyId || number(proposalRow.target_policy_version) !== target.targetPolicyVersion || requirements.rows[0]?.present !== true) throw new ManagedKnowledgePageVersionConflictError();
    await client.query(`UPDATE managed_knowledge_pages SET state = 'updating', version = version + 1, updated_at = $2 WHERE id = $1`, [page.id, normalized.at]);
    await insertPageEvent(client, { pageId: page.id, eventType: "update_claimed", fromVersion: page.version, toVersion: page.version + 1, operationKey: `${normalized.operationKey}:page`, fingerprint: operationFingerprint({ fingerprint, kind: "page" }), actor: normalized.workerId, at: normalized.at });
    const requestFingerprint = operationFingerprint({ targetId: target.id, revision: target.expectedRemoteRevisionId, before: target.currentBodyContentHash, after: target.proposedBodyContentHash, clientToken: normalized.clientToken });
    await client.query(`INSERT INTO knowledge_publication_update_executions (
      id,proposal_id,managed_page_id,managed_page_version,update_target_id,attempt_number,state,operation_key,
      operation_fingerprint,request_fingerprint,expected_remote_revision_id,before_body_content_hash,after_body_content_hash,
      client_token,version,created_at,updated_at
    ) VALUES ($1,$2,$3,$4,$5,1,'claimed',$6,$7,$8,$9,$10,$11,$12,1,$13,$13)`,
    [normalized.id, normalized.proposalId, page.id, page.version + 1, target.id, normalized.operationKey, fingerprint,
      requestFingerprint, target.expectedRemoteRevisionId, target.currentBodyContentHash, target.proposedBodyContentHash,
      normalized.clientToken, normalized.at]);
    await insertExecutionEvent(client, normalized.id, "claimed", undefined, 1, `${normalized.operationKey}:execution`, operationFingerprint({ fingerprint, kind: "execution" }), undefined, normalized.at);
    return { outcome: "applied", page: await requirePage(client, page.id), target, execution: await requireExecution(client, normalized.id) };
  });
}

async function markRemoteRequestDispatched(dataSource: PostgresKnowledgeDraftDataSource, input: MarkManagedRemoteRequestDispatchedInput): Promise<ManagedExecutionMutationResult> {
  const normalized = { executionId: ref("executionId", input.executionId), expectedExecutionVersion: positive("expectedExecutionVersion", input.expectedExecutionVersion), operationKey: ref("operationKey", input.operationKey), actor: ref("actor", input.actor), at: date("at", input.at) };
  const fingerprint = operationFingerprint(normalized);
  return withTransaction(dataSource, async (client) => {
    await lockOperation(client, normalized.operationKey);
    const replay = await client.query<{ execution_id: string; operation_fingerprint: string }>(`SELECT execution_id, operation_fingerprint FROM knowledge_publication_update_execution_events WHERE operation_key = $1`, [normalized.operationKey]);
    if (replay.rows[0] !== undefined) { if (replay.rows[0].operation_fingerprint !== fingerprint) throw new ManagedKnowledgePageOperationConflictError(); const execution = await requireExecution(client, replay.rows[0].execution_id); return { outcome: "already_applied", execution, page: await requirePage(client, execution.managedPageId) }; }
    const identity = await requireExecution(client, normalized.executionId);
    const page = await requirePageForUpdate(client, identity.managedPageId);
    const execution = await requireExecutionForUpdate(client, normalized.executionId);
    if (execution.version !== normalized.expectedExecutionVersion || execution.state !== "claimed" || page.state !== "updating") throw new ManagedKnowledgePageVersionConflictError();
    await client.query(`UPDATE knowledge_publication_update_executions SET state = 'remote_request_dispatched', remote_request_dispatched_at = $2, version = version + 1, updated_at = $2 WHERE id = $1`, [execution.id, normalized.at]);
    await insertExecutionEvent(client, execution.id, "remote_request_dispatched", execution.version, execution.version + 1, normalized.operationKey, fingerprint, undefined, normalized.at);
    return { outcome: "applied", execution: await requireExecution(client, execution.id), page };
  });
}

async function recordRemoteOutcome(dataSource: PostgresKnowledgeDraftDataSource, input: RecordManagedRemoteOutcomeInput): Promise<ManagedExecutionMutationResult> {
  const normalized = normalizeOutcomeInput(input); const fingerprint = operationFingerprint(normalized);
  return withTransaction(dataSource, async (client) => {
    await lockOperation(client, normalized.operationKey);
    const event = await client.query<{ execution_id: string; operation_fingerprint: string }>(`SELECT execution_id, operation_fingerprint FROM knowledge_publication_update_execution_events WHERE operation_key = $1`, [normalized.operationKey]);
    if (event.rows[0] !== undefined) {
      if (event.rows[0].operation_fingerprint !== fingerprint) throw new ManagedKnowledgePageOperationConflictError();
      const execution = await requireExecution(client, event.rows[0].execution_id); return { outcome: "already_applied", execution, page: await requirePage(client, execution.managedPageId) };
    }
    const executionIdentity = await requireExecution(client, normalized.executionId);
    const page = await requirePageForUpdate(client, executionIdentity.managedPageId);
    const execution = await requireExecutionForUpdate(client, normalized.executionId);
    if (execution.version !== normalized.expectedExecutionVersion || (normalized.classification === "preflight_failed" ? execution.state !== "claimed" : !["remote_request_dispatched", "outcome_unknown"].includes(execution.state)) || (normalized.classification === "remote_applied" && normalized.responseRevisionId === undefined)) throw new ManagedKnowledgePageVersionConflictError();
    const pageState = normalized.classification === "remote_applied" ? "resync_required" : normalized.classification === "outcome_unknown" || normalized.classification === "reconciliation_required" ? "reconciliation_required" : (normalized.classification === "preflight_failed" || normalized.classification === "failed") && page.state === "updating" ? "active" : page.state;
    await client.query(`UPDATE knowledge_publication_update_executions SET state = $2, response_classification = $3,
      response_revision_id = $4, reconciliation_reason_code = $5, version = version + 1, updated_at = $6 WHERE id = $1`,
      [execution.id, normalized.classification, normalized.responseClassification ?? null, normalized.responseRevisionId ?? null, normalized.reconciliationReasonCode ?? null, normalized.at]);
    await client.query(`UPDATE managed_knowledge_pages SET state = $2, expected_resync_content_hash = $3,
      version = version + 1, updated_at = $4 WHERE id = $1`, [page.id, pageState, pageState === "resync_required" ? execution.afterBodyContentHash : null, normalized.at]);
    await insertExecutionEvent(client, execution.id, normalized.classification, execution.version, execution.version + 1, normalized.operationKey, fingerprint, normalized.responseClassification ?? normalized.reconciliationReasonCode, normalized.at);
    await insertPageEvent(client, { pageId: page.id, eventType: pageState === "reconciliation_required" ? "reconciliation_required" : "remote_outcome_confirmed", fromVersion: page.version, toVersion: page.version + 1, operationKey: `${normalized.operationKey}:page`, fingerprint: operationFingerprint({ fingerprint, kind: "page" }), actor: normalized.actor, at: normalized.at });
    return { outcome: "applied", execution: await requireExecution(client, execution.id), page: await requirePage(client, page.id) };
  });
}

async function completeResync(dataSource: PostgresKnowledgeDraftDataSource, input: CompleteManagedResyncInput): Promise<ManagedExecutionMutationResult> {
  const normalized = { executionId: ref("executionId", input.executionId), expectedExecutionVersion: positive("expectedExecutionVersion", input.expectedExecutionVersion), observationId: ref("observationId", input.observationId), operationKey: ref("operationKey", input.operationKey), actor: ref("actor", input.actor), at: date("at", input.at) }; const fingerprint = operationFingerprint(normalized);
  return withTransaction(dataSource, async (client) => {
    await lockOperation(client, normalized.operationKey);
    const event = await client.query<{ execution_id: string; operation_fingerprint: string }>(`SELECT execution_id, operation_fingerprint FROM knowledge_publication_update_execution_events WHERE operation_key = $1`, [normalized.operationKey]);
    if (event.rows[0] !== undefined) { if (event.rows[0].operation_fingerprint !== fingerprint) throw new ManagedKnowledgePageOperationConflictError(); const execution = await requireExecution(client, event.rows[0].execution_id); return { outcome: "already_applied", execution, page: await requirePage(client, execution.managedPageId) }; }
    const executionIdentity = await requireExecution(client, normalized.executionId);
    const page = await requirePageForUpdate(client, executionIdentity.managedPageId);
    const target = await requireTargetForUpdate(client, executionIdentity.updateTargetId);
    const execution = await requireExecutionForUpdate(client, normalized.executionId);
    const observation = await requireObservation(client, normalized.observationId);
    if (execution.version !== normalized.expectedExecutionVersion || execution.state !== "remote_applied" || page.state !== "resync_required" || observation.managedPageId !== page.id || observation.managedPageVersion !== execution.managedPageVersion || observation.documentSourceId !== target.linkedDocumentSourceId || observation.documentSnapshotId !== target.targetSnapshotId || observation.observedManagedBodyBlockId !== target.managedBodyBlockId || observation.managedBodyContentHash !== execution.afterBodyContentHash || observation.observedRemoteRevisionId !== execution.responseRevisionId) throw new ManagedKnowledgePageVersionConflictError();
    await client.query(`UPDATE knowledge_publication_update_executions SET state = 'succeeded', version = version + 1, updated_at = $2 WHERE id = $1`, [execution.id, normalized.at]);
    await client.query(`UPDATE managed_knowledge_pages SET state = 'active', current_remote_revision_id = $2, current_body_content_hash = $3, expected_resync_content_hash = NULL, version = version + 1, updated_at = $4 WHERE id = $1`, [page.id, observation.observedRemoteRevisionId, observation.managedBodyContentHash, normalized.at]);
    await insertExecutionEvent(client, execution.id, "succeeded", execution.version, execution.version + 1, normalized.operationKey, fingerprint, undefined, normalized.at);
    await insertPageEvent(client, { pageId: page.id, eventType: "resync_completed", fromVersion: page.version, toVersion: page.version + 1, operationKey: `${normalized.operationKey}:page`, fingerprint: operationFingerprint({ fingerprint, kind: "page" }), actor: normalized.actor, at: normalized.at });
    return { outcome: "applied", execution: await requireExecution(client, execution.id), page: await requirePage(client, page.id) };
  });
}

async function listReconciliationRequired(dataSource: PostgresKnowledgeDraftDataSource, input: { limit: number }): Promise<ClaimedManagedKnowledgeUpdate[]> {
  const result = await dataSource.query<ExecutionRow>(`${executionSelect()} WHERE state IN ('outcome_unknown','reconciliation_required') ORDER BY created_at ASC, id ASC LIMIT $1`, [limit(input.limit)]);
  const values: ClaimedManagedKnowledgeUpdate[] = []; for (const row of result.rows) { const execution = mapExecution(row); values.push({ outcome: "applied", execution, page: await requirePage(dataSource, execution.managedPageId), target: await requireTarget(dataSource, execution.updateTargetId) }); } return values;
}

async function getSourceAvailability(dataSource: PostgresKnowledgeDraftDataSource, documentSourceId: string): Promise<"available" | "barred"> {
  const result = await dataSource.query<{ barred: boolean }>(`SELECT EXISTS (SELECT 1 FROM managed_knowledge_pages WHERE linked_document_source_id = $1 AND state <> 'active') AS barred`, [ref("documentSourceId", documentSourceId)]); return result.rows[0]?.barred === true ? "barred" : "available";
}

async function pageReplay(client: KnowledgeDraftTransactionClient, operationKey: string, fingerprint: string): Promise<ManagedKnowledgePage | undefined> { const result = await client.query<{ managed_page_id: string; operation_fingerprint: string }>(`SELECT managed_page_id, operation_fingerprint FROM managed_knowledge_page_events WHERE operation_key = $1`, [operationKey]); if (result.rows[0] === undefined) return undefined; if (result.rows[0].operation_fingerprint !== fingerprint) throw new ManagedKnowledgePageOperationConflictError(); return requirePage(client, result.rows[0].managed_page_id); }
async function requirePage(queryable: Pick<PostgresKnowledgeDraftDataSource, "query">, id: string): Promise<ManagedKnowledgePage> { const result = await queryable.query<PageRow>(`${pageSelect()} WHERE id = $1`, [id]); if (result.rows[0] === undefined) throw new ManagedKnowledgePageVersionConflictError(); return mapPage(result.rows[0]); }
async function requirePageForUpdate(client: KnowledgeDraftTransactionClient, id: string): Promise<ManagedKnowledgePage> { const result = await client.query<PageRow>(`${pageSelect()} WHERE id = $1 FOR UPDATE`, [id]); if (result.rows[0] === undefined) throw new ManagedKnowledgePageVersionConflictError(); return mapPage(result.rows[0]); }
async function requireTarget(queryable: Pick<PostgresKnowledgeDraftDataSource, "query">, id: string): Promise<ManagedKnowledgeUpdateTarget> { const result = await queryable.query<TargetRow>(`${targetSelect()} WHERE id = $1`, [id]); if (result.rows[0] === undefined) throw new ManagedKnowledgePageVersionConflictError(); return mapTarget(result.rows[0]); }
async function requireTargetForUpdate(client: KnowledgeDraftTransactionClient, id: string): Promise<ManagedKnowledgeUpdateTarget> { const result = await client.query<TargetRow>(`${targetSelect()} WHERE id = $1 FOR UPDATE`, [id]); if (result.rows[0] === undefined) throw new ManagedKnowledgePageVersionConflictError(); return mapTarget(result.rows[0]); }
async function requireExecution(queryable: Pick<PostgresKnowledgeDraftDataSource, "query">, id: string): Promise<ManagedKnowledgeUpdateExecution> { const result = await queryable.query<ExecutionRow>(`${executionSelect()} WHERE id = $1`, [id]); if (result.rows[0] === undefined) throw new ManagedKnowledgePageVersionConflictError(); return mapExecution(result.rows[0]); }
async function requireExecutionForUpdate(client: KnowledgeDraftTransactionClient, id: string): Promise<ManagedKnowledgeUpdateExecution> { const result = await client.query<ExecutionRow>(`${executionSelect()} WHERE id = $1 FOR UPDATE`, [id]); if (result.rows[0] === undefined) throw new ManagedKnowledgePageVersionConflictError(); return mapExecution(result.rows[0]); }
async function requireObservation(queryable: Pick<PostgresKnowledgeDraftDataSource, "query">, id: string): Promise<ManagedSnapshotObservation> { const result = await queryable.query<ObservationRow>(`${observationSelect()} WHERE id = $1`, [id]); if (result.rows[0] === undefined) throw new ManagedKnowledgePageVersionConflictError(); return mapObservation(result.rows[0]); }
async function insertPageEvent(client: KnowledgeDraftTransactionClient, value: { pageId: string; eventType: string; fromVersion?: number; toVersion: number; operationKey: string; fingerprint: string; actor?: string; at: Date }): Promise<void> { await client.query(`INSERT INTO managed_knowledge_page_events (id,managed_page_id,event_type,from_version,to_version,operation_key,operation_fingerprint,actor,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [randomUUID(),value.pageId,value.eventType,value.fromVersion ?? null,value.toVersion,value.operationKey,value.fingerprint,value.actor ?? null,value.at]); }
async function insertExecutionEvent(client: KnowledgeDraftTransactionClient, executionId: string, eventType: string, fromVersion: number | undefined, toVersion: number, operationKey: string, fingerprint: string, reasonCode: string | undefined, at: Date): Promise<void> { await client.query(`INSERT INTO knowledge_publication_update_execution_events (id,execution_id,event_type,from_version,to_version,operation_key,operation_fingerprint,reason_code,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [randomUUID(),executionId,eventType,fromVersion ?? null,toVersion,operationKey,fingerprint,reasonCode ?? null,at]); }
function pageSelect(): string { return `SELECT id,origin_knowledge_publication_id,target_policy_id,target_policy_version,authorization_group_id,remote_node_token,remote_document_token,managed_body_block_id,linked_document_source_id,current_remote_revision_id,current_body_content_hash,expected_resync_content_hash,state,version,created_at,updated_at FROM managed_knowledge_pages`; }
function targetSelect(): string { return `SELECT id,draft_id,draft_revision,draft_version,conflict_candidate_id,conflict_candidate_version,managed_page_id,managed_page_version,linked_document_source_id,target_snapshot_id,target_snapshot_hash,target_source_version,remote_document_token,managed_body_block_id,expected_remote_revision_id,current_body_content_hash,proposed_body_content_hash,authorization_group_id,target_policy_id,target_policy_version,operation_key,operation_fingerprint,created_at FROM knowledge_publication_update_targets`; }
function executionSelect(): string { return `SELECT id,proposal_id,managed_page_id,managed_page_version,update_target_id,attempt_number,state,operation_key,operation_fingerprint,request_fingerprint,expected_remote_revision_id,before_body_content_hash,after_body_content_hash,client_token,response_revision_id,response_classification,reconciliation_reason_code,remote_request_dispatched_at,version,created_at,updated_at FROM knowledge_publication_update_executions`; }
function observationSelect(): string { return `SELECT id,managed_page_id,managed_page_version,document_snapshot_id,document_source_id,snapshot_content_hash,observed_remote_revision_id,observed_managed_body_block_id,observed_block_type,managed_body_content_hash,adapter_version,operation_key,operation_fingerprint,observed_at FROM managed_knowledge_snapshot_observations`; }
function mapPage(row: PageRow): ManagedKnowledgePage { return normalizeManagedKnowledgePage({ id:text(row.id),originKnowledgePublicationId:text(row.origin_knowledge_publication_id),targetPolicyId:text(row.target_policy_id),targetPolicyVersion:number(row.target_policy_version),authorizationGroupId:text(row.authorization_group_id),remoteNodeToken:text(row.remote_node_token),remoteDocumentToken:text(row.remote_document_token),managedBodyBlockId:text(row.managed_body_block_id),...(row.linked_document_source_id === null ? {} : {linkedDocumentSourceId:text(row.linked_document_source_id)}),...(row.current_remote_revision_id === null ? {} : {currentRemoteRevisionId:text(row.current_remote_revision_id)}),...(row.current_body_content_hash === null ? {} : {currentBodyContentHash:text(row.current_body_content_hash)}),...(row.expected_resync_content_hash === null ? {} : {expectedResyncContentHash:text(row.expected_resync_content_hash)}),state:text(row.state) as ManagedKnowledgePage["state"],version:number(row.version),createdAt:date("created_at",row.created_at),updatedAt:date("updated_at",row.updated_at) }); }
function mapTarget(row: TargetRow): ManagedKnowledgeUpdateTarget { return { id:text(row.id),draftId:text(row.draft_id),draftRevision:number(row.draft_revision),draftVersion:number(row.draft_version),conflictCandidateId:text(row.conflict_candidate_id),conflictCandidateVersion:number(row.conflict_candidate_version),managedPageId:text(row.managed_page_id),managedPageVersion:number(row.managed_page_version),linkedDocumentSourceId:text(row.linked_document_source_id),targetSnapshotId:text(row.target_snapshot_id),targetSnapshotHash:text(row.target_snapshot_hash),...(row.target_source_version === null ? {} : {targetSourceVersion:text(row.target_source_version)}),remoteDocumentToken:text(row.remote_document_token),managedBodyBlockId:text(row.managed_body_block_id),expectedRemoteRevisionId:text(row.expected_remote_revision_id),currentBodyContentHash:text(row.current_body_content_hash),proposedBodyContentHash:text(row.proposed_body_content_hash),authorizationGroupId:text(row.authorization_group_id),targetPolicyId:text(row.target_policy_id),targetPolicyVersion:number(row.target_policy_version),operationKey:text(row.operation_key),createdAt:date("created_at",row.created_at) }; }
function mapExecution(row: ExecutionRow): ManagedKnowledgeUpdateExecution { return { id:text(row.id),proposalId:text(row.proposal_id),managedPageId:text(row.managed_page_id),managedPageVersion:number(row.managed_page_version),updateTargetId:text(row.update_target_id),attemptNumber:number(row.attempt_number),state:text(row.state) as ManagedKnowledgeUpdateExecution["state"],operationKey:text(row.operation_key),requestFingerprint:text(row.request_fingerprint),expectedRemoteRevisionId:text(row.expected_remote_revision_id),beforeBodyContentHash:text(row.before_body_content_hash),afterBodyContentHash:text(row.after_body_content_hash),clientToken:text(row.client_token),...(row.response_revision_id === null ? {} : {responseRevisionId:text(row.response_revision_id)}),...(row.response_classification === null ? {} : {responseClassification:text(row.response_classification)}),...(row.reconciliation_reason_code === null ? {} : {reconciliationReasonCode:text(row.reconciliation_reason_code)}),...(row.remote_request_dispatched_at === null ? {} : {remoteRequestDispatchedAt:date("remote_request_dispatched_at",row.remote_request_dispatched_at)}),version:number(row.version),createdAt:date("created_at",row.created_at),updatedAt:date("updated_at",row.updated_at) }; }
function mapObservation(row: ObservationRow): ManagedSnapshotObservation { return { id:text(row.id),managedPageId:text(row.managed_page_id),managedPageVersion:number(row.managed_page_version),documentSnapshotId:text(row.document_snapshot_id),documentSourceId:text(row.document_source_id),snapshotContentHash:text(row.snapshot_content_hash),observedRemoteRevisionId:text(row.observed_remote_revision_id),observedManagedBodyBlockId:text(row.observed_managed_body_block_id),observedBlockType:"text",managedBodyContentHash:text(row.managed_body_content_hash),adapterVersion:text(row.adapter_version),observedAt:date("observed_at",row.observed_at) }; }
function normalizeRegisterInput(input: RegisterManagedPublicationInput): RegisterManagedPublicationInput { return { id:ref("id",input.id),originKnowledgePublicationId:ref("originKnowledgePublicationId",input.originKnowledgePublicationId),targetPolicyId:ref("targetPolicyId",input.targetPolicyId),targetPolicyVersion:positive("targetPolicyVersion",input.targetPolicyVersion),authorizationGroupId:ref("authorizationGroupId",input.authorizationGroupId),remoteNodeToken:ref("remoteNodeToken",input.remoteNodeToken),remoteDocumentToken:ref("remoteDocumentToken",input.remoteDocumentToken),managedBodyBlockId:ref("managedBodyBlockId",input.managedBodyBlockId),currentRemoteRevisionId:ref("currentRemoteRevisionId",input.currentRemoteRevisionId),currentBodyContentHash:hash("currentBodyContentHash",input.currentBodyContentHash),operationKey:ref("operationKey",input.operationKey),actor:ref("actor",input.actor),at:date("at",input.at) }; }
function normalizeObservationInput(input: RecordManagedSnapshotObservationInput): RecordManagedSnapshotObservationInput { return { ...input,id:ref("id",input.id),managedPageId:ref("managedPageId",input.managedPageId),managedPageVersion:positive("managedPageVersion",input.managedPageVersion),documentSnapshotId:ref("documentSnapshotId",input.documentSnapshotId),documentSourceId:ref("documentSourceId",input.documentSourceId),snapshotContentHash:hash("snapshotContentHash",input.snapshotContentHash),observedRemoteRevisionId:ref("observedRemoteRevisionId",input.observedRemoteRevisionId),observedManagedBodyBlockId:ref("observedManagedBodyBlockId",input.observedManagedBodyBlockId),managedBodyContentHash:hash("managedBodyContentHash",input.managedBodyContentHash),adapterVersion:ref("adapterVersion",input.adapterVersion),operationKey:ref("operationKey",input.operationKey),at:date("at",input.at),observedAt:date("observedAt",input.observedAt) }; }
function normalizeTargetInput(input: BindManagedUpdateTargetInput): BindManagedUpdateTargetInput { return { ...input,id:ref("id",input.id),draftId:ref("draftId",input.draftId),draftRevision:positive("draftRevision",input.draftRevision),draftVersion:positive("draftVersion",input.draftVersion),conflictCandidateId:ref("conflictCandidateId",input.conflictCandidateId),conflictCandidateVersion:positive("conflictCandidateVersion",input.conflictCandidateVersion),managedPageId:ref("managedPageId",input.managedPageId),managedPageVersion:positive("managedPageVersion",input.managedPageVersion),linkedDocumentSourceId:ref("linkedDocumentSourceId",input.linkedDocumentSourceId),targetSnapshotId:ref("targetSnapshotId",input.targetSnapshotId),targetSnapshotHash:hash("targetSnapshotHash",input.targetSnapshotHash),...(input.targetSourceVersion === undefined ? {} : {targetSourceVersion:ref("targetSourceVersion",input.targetSourceVersion)}),remoteDocumentToken:ref("remoteDocumentToken",input.remoteDocumentToken),managedBodyBlockId:ref("managedBodyBlockId",input.managedBodyBlockId),expectedRemoteRevisionId:ref("expectedRemoteRevisionId",input.expectedRemoteRevisionId),currentBodyContentHash:hash("currentBodyContentHash",input.currentBodyContentHash),proposedBodyContentHash:hash("proposedBodyContentHash",input.proposedBodyContentHash),authorizationGroupId:ref("authorizationGroupId",input.authorizationGroupId),targetPolicyId:ref("targetPolicyId",input.targetPolicyId),targetPolicyVersion:positive("targetPolicyVersion",input.targetPolicyVersion),operationKey:ref("operationKey",input.operationKey),at:date("at",input.at) }; }
function normalizeOutcomeInput(input: RecordManagedRemoteOutcomeInput): RecordManagedRemoteOutcomeInput { const classification = input.classification; if (!['preflight_failed','outcome_unknown','remote_applied','failed','reconciliation_required'].includes(classification)) throw new Error('classification is invalid'); if ((classification === 'outcome_unknown' || classification === 'reconciliation_required') && input.reconciliationReasonCode === undefined) throw new Error('reconciliationReasonCode is required'); return { ...input,executionId:ref('executionId',input.executionId),expectedExecutionVersion:positive('expectedExecutionVersion',input.expectedExecutionVersion),...(input.responseClassification === undefined ? {} : {responseClassification:ref('responseClassification',input.responseClassification)}),...(input.responseRevisionId === undefined ? {} : {responseRevisionId:ref('responseRevisionId',input.responseRevisionId)}),...(input.reconciliationReasonCode === undefined ? {} : {reconciliationReasonCode:ref('reconciliationReasonCode',input.reconciliationReasonCode)}),operationKey:ref('operationKey',input.operationKey),actor:ref('actor',input.actor),at:date('at',input.at) }; }
async function withTransaction<T>(dataSource: PostgresKnowledgeDraftDataSource, operation: (client: KnowledgeDraftTransactionClient) => Promise<T>): Promise<T> { const client = await dataSource.connect(); try { await client.query('BEGIN'); const result = await operation(client); await client.query('COMMIT'); return result; } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; } finally { client.release(); } }
async function lockOperation(client: KnowledgeDraftTransactionClient, key: string): Promise<void> { await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [key]); }
function operationFingerprint(value: unknown): string { return createHash('sha256').update(JSON.stringify(value, (_key, item) => item instanceof Date ? item.toISOString() : item)).digest('hex'); }
function ref(name: string, value: unknown): string { if (typeof value !== 'string') throw new Error(`${name} must be a string`); const normalized = value.trim(); if ([...normalized].length < 1 || [...normalized].length > 512) throw new Error(`${name} is invalid`); return normalized; }
function hash(name: string, value: unknown): string { if (typeof value !== 'string' || !/^[0-9a-f]{64}$/u.test(value)) throw new Error(`${name} is invalid`); return value; }
function positive(name: string, value: unknown): number { if (!Number.isSafeInteger(value) || Number(value) < 1) throw new Error(`${name} is invalid`); return Number(value); }
function limit(value: unknown): number { const result = positive('limit',value); if (result > 100) throw new Error('limit is invalid'); return result; }
function date(name: string, value: unknown): Date { if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new Error(`${name} is invalid`); return value; }
function text(value: unknown): string { if (typeof value !== 'string') throw new Error('database row is invalid'); return value; }
function number(value: unknown): number { const result = Number(value); if (!Number.isSafeInteger(result)) throw new Error('database row is invalid'); return result; }
