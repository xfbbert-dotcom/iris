import { createHash, randomUUID } from "node:crypto";

import type {
  KnowledgeDraftTransactionClient,
  PostgresKnowledgeDraftDataSource,
} from "../knowledge-governance/postgres-knowledge-draft-repository.js";
import { acquireManagedKnowledgeSourceLocks } from
  "../documents/managed-knowledge-source-lock.js";

import type {
  ManagedKnowledgePage,
  ManagedKnowledgeUpdateExecution,
  ManagedKnowledgeUpdateTarget,
  ManagedSnapshotObservation,
} from "./managed-knowledge-page.js";
import { canonicalManagedBodyHash, normalizeManagedKnowledgePage } from "./managed-knowledge-page.js";
import type {
  BindManagedUpdateTargetInput,
  ClaimManagedRemoteRetryInput,
  ClaimManagedUpdateInput,
  ClaimedManagedKnowledgeUpdate,
  CompleteManagedResyncInput,
  EligibleManagedPageForConflictInput,
  FindManagedPageByRemoteIdentityInput,
  LinkManagedPageSourceInput,
  MarkManagedRemoteRequestDispatchedInput,
  ManagedExecutionMutationResult,
  ManagedKnowledgePageRepository,
  ManagedPageMutationResult,
  ManagedResyncReadyExecution,
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

export class ManagedKnowledgePageIdentityConflictError extends Error {
  constructor() {
    super("managed knowledge page remote identity is ambiguous");
    this.name = "ManagedKnowledgePageIdentityConflictError";
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
    findByRemoteIdentity: (input) => findByRemoteIdentity(dataSource, input),
    findEligiblePageForConflict: (input) => findEligiblePageForConflict(dataSource, input),
    linkSource: (input) => linkSource(dataSource, input),
    recordSnapshotObservation: (input) => recordSnapshotObservation(dataSource, input),
    bindConflictDraft: (input) => bindConflictDraft(dataSource, input),
    getTargetForDraft: (input) => getTargetForDraft(dataSource, input),
    claimApprovedUpdate: (input) => claimApprovedUpdate(dataSource, input),
    markRemoteRequestDispatched: (input) => markRemoteRequestDispatched(dataSource, input),
    claimRemoteRetry: (input) => claimRemoteRetry(dataSource, input),
    recordRemoteOutcome: (input) => recordRemoteOutcome(dataSource, input),
    completeResync: (input) => completeResync(dataSource, input),
    findResyncReadyExecution: (input) => findResyncReadyExecution(dataSource, input),
    listReconciliationRequired: (input) => listReconciliationRequired(dataSource, input),
    getSourceAvailability: (documentSourceId) => getSourceAvailability(dataSource, documentSourceId),
  };
}

async function findByRemoteIdentity(
  dataSource: PostgresKnowledgeDraftDataSource,
  input: FindManagedPageByRemoteIdentityInput,
): Promise<ManagedKnowledgePage | undefined> {
  const remoteWikiNodeToken = input.remoteWikiNodeToken === undefined
    ? undefined
    : ref("remoteWikiNodeToken", input.remoteWikiNodeToken);
  const remoteDocumentToken = input.remoteDocumentToken === undefined
    ? undefined
    : ref("remoteDocumentToken", input.remoteDocumentToken);
  if (remoteWikiNodeToken === undefined && remoteDocumentToken === undefined) {
    throw new Error("managed knowledge page remote identity is required");
  }

  const clauses: string[] = [];
  const values: string[] = [];
  if (remoteWikiNodeToken !== undefined) {
    values.push(remoteWikiNodeToken);
    clauses.push(`remote_node_token = $${values.length}`);
  }
  if (remoteDocumentToken !== undefined) {
    values.push(remoteDocumentToken);
    clauses.push(`remote_document_token = $${values.length}`);
  }
  const result = await dataSource.query<PageRow>(
    `${pageSelect()} WHERE ${clauses.join(" OR ")} LIMIT 2`,
    values,
  );
  if (result.rows.length === 0) return undefined;
  if (result.rows.length !== 1) throw new ManagedKnowledgePageIdentityConflictError();

  const page = mapPage(result.rows[0]);
  if (
    (remoteWikiNodeToken !== undefined && page.remoteNodeToken !== remoteWikiNodeToken) ||
    (remoteDocumentToken !== undefined && page.remoteDocumentToken !== remoteDocumentToken)
  ) {
    throw new ManagedKnowledgePageIdentityConflictError();
  }
  return page;
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
    await acquireManagedKnowledgeSourceLocks(client, [normalized.documentSourceId]);
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
  const normalized = normalizeClaimInput(input);
  const fingerprint = operationFingerprint(normalized);
  return withTransaction(dataSource, async (client) => {
    await lockOperation(client, normalized.operationKey);
    const replay = await client.query<ExecutionRow>(`${executionSelect()} WHERE operation_key = $1`, [normalized.operationKey]);
    if (replay.rows[0] !== undefined) {
      if (text(replay.rows[0].operation_fingerprint) !== fingerprint) throw new ManagedKnowledgePageOperationConflictError();
      return buildClaimResult(client, mapExecution(replay.rows[0]), "already_applied");
    }
    const targetIdentity = await requireTargetForProposal(client, normalized.proposalId);
    await acquireManagedKnowledgeSourceLocks(client, [targetIdentity.linkedDocumentSourceId]);
    const page = await requirePageForUpdate(client, targetIdentity.managedPageId);
    const target = await requireTargetForUpdate(client, targetIdentity.id);
    const candidate = await client.query<Record<string, unknown>>(
      `SELECT version,status,group_id,target_document_source_id,target_snapshot_id,
              target_content_hash,target_source_version
       FROM knowledge_conflict_candidates WHERE id = $1 FOR UPDATE`,
      [target.conflictCandidateId],
    );
    const proposal = await client.query<Record<string, unknown>>(
      `SELECT id,action_type,subject_type,subject_id,subject_revision,subject_version,
              target_policy_id,target_policy_version,risk_level,status,operation_key,
              operation_fingerprint,version,created_at,updated_at
       FROM action_proposals WHERE id = $1 FOR UPDATE`,
      [normalized.proposalId],
    );
    const proposalRow = proposal.rows[0];
    const draft = await client.query<Record<string, unknown>>(
      `SELECT draft.id,draft.source_group_id,draft.status,draft.current_revision_number,draft.version,
              revision.title,revision.content,revision.risk_level
       FROM knowledge_drafts draft
       JOIN knowledge_draft_revisions revision
         ON revision.draft_id = draft.id AND revision.revision_number = draft.current_revision_number
       WHERE draft.id = $1 FOR UPDATE OF draft`,
      [target.draftId],
    );
    const draftRow = draft.rows[0];
    const policy = await client.query<Record<string, unknown>>(
      `SELECT id,space_id,parent_node_token,display_name,allowed_group_ids,allowed_risk_levels,
              enabled,version,created_at,updated_at
       FROM knowledge_publication_target_policies WHERE id = $1 FOR UPDATE`,
      [target.targetPolicyId],
    );
    const policyRow = policy.rows[0];
    const source = await client.query<Record<string, unknown>>(
      `SELECT id,source_type,permission_state,sync_state,can_use_for_answering,can_use_for_knowledge_drafts
       FROM document_sources WHERE id = $1 FOR SHARE`,
      [target.linkedDocumentSourceId],
    );
    const sourceRow = source.rows[0];
    const snapshot = await client.query<Record<string, unknown>>(
      `SELECT id,document_source_id,content_hash,source_version,fetch_status
       FROM document_snapshots WHERE id = $1 FOR SHARE`,
      [target.targetSnapshotId],
    );
    const snapshotRow = snapshot.rows[0];
    const candidateRow = candidate.rows[0];
    if (
      proposalRow === undefined || draftRow === undefined || policyRow === undefined ||
      sourceRow === undefined || snapshotRow === undefined || candidateRow === undefined ||
      !normalized.runtimeGate.deploymentEnabled || !normalized.runtimeGate.globalEnabled ||
      !normalized.runtimeGate.writeKnowledgeBase || !normalized.runtimeGate.updateManagedKnowledge ||
      normalized.runtimeGate.disabledGroupIds.includes(target.authorizationGroupId) ||
      !normalized.runtimeGate.allowedGroupIds.includes(target.authorizationGroupId) ||
      page.version !== target.managedPageVersion || page.state !== "active" ||
      page.linkedDocumentSourceId !== target.linkedDocumentSourceId ||
      page.authorizationGroupId !== target.authorizationGroupId ||
      page.targetPolicyId !== target.targetPolicyId || page.targetPolicyVersion !== target.targetPolicyVersion ||
      page.remoteDocumentToken !== target.remoteDocumentToken ||
      page.managedBodyBlockId !== target.managedBodyBlockId ||
      page.currentRemoteRevisionId !== target.expectedRemoteRevisionId ||
      page.currentBodyContentHash !== target.currentBodyContentHash ||
      text(proposalRow.action_type) !== "update_knowledge_publication" ||
      text(proposalRow.status) !== "approved" ||
      number(proposalRow.version) !== normalized.expectedProposalVersion ||
      text(proposalRow.subject_type) !== "knowledge_draft" ||
      text(proposalRow.subject_id) !== target.draftId ||
      number(proposalRow.subject_revision) !== target.draftRevision ||
      number(proposalRow.subject_version) !== target.draftVersion ||
      text(proposalRow.target_policy_id) !== target.targetPolicyId ||
      number(proposalRow.target_policy_version) !== target.targetPolicyVersion ||
      text(proposalRow.risk_level) !== text(draftRow.risk_level) ||
      text(draftRow.status) !== "pending_review" ||
      text(draftRow.id) !== target.draftId ||
      number(draftRow.current_revision_number) !== target.draftRevision ||
      number(draftRow.version) !== target.draftVersion ||
      text(draftRow.source_group_id) !== target.authorizationGroupId ||
      canonicalManagedBodyHash(text(draftRow.content)) !== target.proposedBodyContentHash ||
      number(candidateRow.version) !== target.conflictCandidateVersion + 1 ||
      text(candidateRow.status) !== "draft_created" ||
      text(candidateRow.group_id) !== target.authorizationGroupId ||
      text(candidateRow.target_document_source_id) !== target.linkedDocumentSourceId ||
      text(candidateRow.target_snapshot_id) !== target.targetSnapshotId ||
      text(candidateRow.target_content_hash) !== target.targetSnapshotHash ||
      nullableText(candidateRow.target_source_version) !== target.targetSourceVersion ||
      text(policyRow.id) !== target.targetPolicyId || number(policyRow.version) !== target.targetPolicyVersion ||
      policyRow.enabled !== true || !stringArray(policyRow.allowed_group_ids).includes(target.authorizationGroupId) ||
      !stringArray(policyRow.allowed_risk_levels).includes(text(draftRow.risk_level)) ||
      text(sourceRow.id) !== target.linkedDocumentSourceId ||
      text(sourceRow.source_type) !== "authorized_wiki_document" ||
      !["readable", "unknown"].includes(text(sourceRow.permission_state)) ||
      text(sourceRow.sync_state) !== "synced" || sourceRow.can_use_for_answering !== true ||
      sourceRow.can_use_for_knowledge_drafts !== true ||
      text(snapshotRow.id) !== target.targetSnapshotId ||
      text(snapshotRow.document_source_id) !== target.linkedDocumentSourceId ||
      text(snapshotRow.content_hash) !== target.targetSnapshotHash ||
      nullableText(snapshotRow.source_version) !== target.targetSourceVersion ||
      text(snapshotRow.fetch_status) !== "succeeded"
    ) throw new ManagedKnowledgePageVersionConflictError();
    const expectedActionTargetFingerprint = managedUpdateActionTargetFingerprint({
      proposalId: normalized.proposalId,
      proposalVersion: normalized.expectedProposalVersion,
      target,
    });
    const contentHash = createHash("sha256").update(text(draftRow.content)).digest("hex");
    const requirements = await client.query<{ present: boolean }>(
      `SELECT
         NOT EXISTS (
           SELECT 1 FROM action_approval_requirements
           WHERE proposal_id = $2 AND state <> 'satisfied'
         )
         AND EXISTS (
           SELECT 1 FROM action_approval_requirements WHERE proposal_id = $2
         )
         AND EXISTS (
           SELECT 1 FROM action_review_attestations
           WHERE proposal_id = $2 AND proposal_version = $3
             AND subject_revision = $4 AND subject_version = $5
             AND content_hash = $6 AND action_target_fingerprint = $1
         ) AS present`,
      [expectedActionTargetFingerprint, normalized.proposalId, normalized.expectedProposalVersion,
        target.draftRevision, target.draftVersion, contentHash],
    );
    if (requirements.rows[0]?.present !== true) throw new ManagedKnowledgePageVersionConflictError();
    const unresolved = await client.query<{ id: string }>(
      `SELECT id FROM knowledge_publication_update_executions
       WHERE managed_page_id = $1
         AND state IN ('claimed','remote_request_dispatched','outcome_unknown','remote_applied',
           'resync_required','reconciliation_required')
       FOR UPDATE`,
      [page.id],
    );
    if (unresolved.rows[0] !== undefined) throw new ManagedKnowledgePageVersionConflictError();
    const executionId = stableUuid(`${normalized.operationKey}:execution`);
    const clientToken = stableUuid(`${normalized.operationKey}:client-token`);
    await client.query(`UPDATE managed_knowledge_pages SET state = 'updating', version = version + 1, updated_at = $2 WHERE id = $1`, [page.id, normalized.at]);
    await insertPageEvent(client, { pageId: page.id, eventType: "update_claimed", fromVersion: page.version, toVersion: page.version + 1, operationKey: `${normalized.operationKey}:page`, fingerprint: operationFingerprint({ fingerprint, kind: "page" }), actor: normalized.workerId, at: normalized.at });
    const requestFingerprint = operationFingerprint({ targetId: target.id, revision: target.expectedRemoteRevisionId, before: target.currentBodyContentHash, after: target.proposedBodyContentHash, clientToken });
    await client.query(`INSERT INTO knowledge_publication_update_executions (
      id,proposal_id,managed_page_id,managed_page_version,update_target_id,attempt_number,state,operation_key,
      operation_fingerprint,request_fingerprint,expected_remote_revision_id,before_body_content_hash,after_body_content_hash,
      client_token,version,created_at,updated_at
    ) VALUES ($1,$2,$3,$4,$5,1,'claimed',$6,$7,$8,$9,$10,$11,$12,1,$13,$13)`,
    [executionId, normalized.proposalId, page.id, page.version + 1, target.id, normalized.operationKey, fingerprint,
      requestFingerprint, target.expectedRemoteRevisionId, target.currentBodyContentHash, target.proposedBodyContentHash,
      clientToken, normalized.at]);
    await insertExecutionEvent(client, executionId, "claimed", undefined, 1, `${normalized.operationKey}:execution`, operationFingerprint({ fingerprint, kind: "execution" }), undefined, normalized.at);
    await client.query(
      `UPDATE action_proposals SET status = 'executing',version = version + 1,updated_at = $2
       WHERE id = $1 AND version = $3 AND status = 'approved'`,
      [normalized.proposalId, normalized.at, normalized.expectedProposalVersion],
    );
    await client.query(
      `INSERT INTO action_events (
         id,proposal_id,event_type,operation_key,from_version,to_version,reason_code,created_at
       ) VALUES ($1,$2,'execution_started',$3,$4,$5,'managed_update_execution_claimed',$6)`,
      [randomUUID(), normalized.proposalId, `${normalized.operationKey}:proposal`,
        normalized.expectedProposalVersion, normalized.expectedProposalVersion + 1, normalized.at],
    );
    const execution = await requireExecution(client, executionId);
    return {
      outcome: "applied",
      page: await requirePage(client, page.id),
      target,
      execution,
      proposal: mapClaimProposal({ ...proposalRow, status: "executing", version: normalized.expectedProposalVersion + 1, updated_at: normalized.at }),
      draft: mapClaimDraft(draftRow),
    };
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

async function claimRemoteRetry(
  dataSource: PostgresKnowledgeDraftDataSource,
  input: ClaimManagedRemoteRetryInput,
): Promise<ManagedExecutionMutationResult> {
  const normalized = {
    executionId: ref("executionId", input.executionId),
    expectedExecutionVersion: positive("expectedExecutionVersion", input.expectedExecutionVersion),
    operationKey: ref("operationKey", input.operationKey),
    actor: ref("actor", input.actor),
    at: date("at", input.at),
    staleDispatchedBefore: date("staleDispatchedBefore", input.staleDispatchedBefore),
  };
  const fingerprint = operationFingerprint(normalized);
  return withTransaction(dataSource, async (client) => {
    await lockOperation(client, normalized.operationKey);
    const replay = await client.query<{ execution_id: string; operation_fingerprint: string }>(
      `SELECT execution_id,operation_fingerprint
       FROM knowledge_publication_update_execution_events WHERE operation_key = $1`,
      [normalized.operationKey],
    );
    if (replay.rows[0] !== undefined) {
      if (replay.rows[0].operation_fingerprint !== fingerprint) {
        throw new ManagedKnowledgePageOperationConflictError();
      }
      const execution = await requireExecution(client, replay.rows[0].execution_id);
      return { outcome: "already_applied", execution, page: await requirePage(client, execution.managedPageId) };
    }
    const identity = await requireExecution(client, normalized.executionId);
    const page = await requirePageForUpdate(client, identity.managedPageId);
    const execution = await requireExecutionForUpdate(client, normalized.executionId);
    const priorRetry = await client.query<{ present: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM knowledge_publication_update_execution_events
         WHERE execution_id = $1 AND event_type = 'safe_retry_dispatched'
       ) AS present`,
      [execution.id],
    );
    if (
      execution.version !== normalized.expectedExecutionVersion ||
      !["remote_request_dispatched", "outcome_unknown", "reconciliation_required"].includes(execution.state) ||
      (execution.state === "remote_request_dispatched" && (
        execution.remoteRequestDispatchedAt === undefined ||
        execution.remoteRequestDispatchedAt > normalized.staleDispatchedBefore
      )) ||
      !["reconciliation_required", "updating"].includes(page.state) ||
      priorRetry.rows[0]?.present === true
    ) throw new ManagedKnowledgePageVersionConflictError();
    await client.query(
      `UPDATE knowledge_publication_update_executions
       SET state = 'remote_request_dispatched',remote_request_dispatched_at = $2,
           version = version + 1,updated_at = $2 WHERE id = $1`,
      [execution.id, normalized.at],
    );
    await insertExecutionEvent(client, execution.id, "safe_retry_dispatched", execution.version,
      execution.version + 1, normalized.operationKey, fingerprint, undefined, normalized.at);
    return {
      outcome: "applied",
      execution: await requireExecution(client, execution.id),
      page,
    };
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
    const target = await requireTargetForUpdate(client, executionIdentity.updateTargetId);
    const proposalResult = await client.query<Record<string, unknown>>(
      `SELECT id,status,version FROM action_proposals WHERE id = $1 FOR UPDATE`,
      [executionIdentity.proposalId],
    );
    const proposal = proposalResult.rows[0];
    const execution = await requireExecutionForUpdate(client, normalized.executionId);
    if (
      proposal === undefined || execution.version !== normalized.expectedExecutionVersion ||
      !validOutcomePredecessor(execution.state, normalized.classification) ||
      !validPageDisposition(normalized.classification, normalized.pageDisposition) ||
      (normalized.classification === "remote_applied" && normalized.responseRevisionId === undefined) ||
      (normalized.pageDisposition === "active" && (
        normalized.classification !== "preflight_failed" || execution.state !== "claimed" ||
        normalized.verifiedUnchangedRemote === undefined ||
        normalized.verifiedUnchangedRemote.remoteDocumentToken !== target.remoteDocumentToken ||
        normalized.verifiedUnchangedRemote.managedBodyBlockId !== target.managedBodyBlockId ||
        normalized.verifiedUnchangedRemote.remoteRevisionId !== target.expectedRemoteRevisionId ||
        normalized.verifiedUnchangedRemote.bodyContentHash !== target.currentBodyContentHash ||
        page.state !== "updating" || page.version !== execution.managedPageVersion ||
        page.id !== target.managedPageId || page.linkedDocumentSourceId !== target.linkedDocumentSourceId ||
        page.remoteDocumentToken !== target.remoteDocumentToken ||
        page.managedBodyBlockId !== target.managedBodyBlockId ||
        page.currentRemoteRevisionId !== target.expectedRemoteRevisionId ||
        page.currentBodyContentHash !== target.currentBodyContentHash
      ))
    ) throw new ManagedKnowledgePageVersionConflictError();
    const pageState = normalized.pageDisposition;
    await client.query(`UPDATE knowledge_publication_update_executions SET state = $2, response_classification = $3,
      response_revision_id = COALESCE($4,response_revision_id), reconciliation_reason_code = $5,
      version = version + 1, updated_at = $6 WHERE id = $1`,
      [execution.id, normalized.classification, normalized.responseClassification ?? null, normalized.responseRevisionId ?? null, normalized.reconciliationReasonCode ?? null, normalized.at]);
    const expectedResyncHash = pageState === "resync_required" ||
      (pageState === "reconciliation_required" &&
        (execution.state === "remote_applied" || execution.responseRevisionId !== undefined || normalized.responseRevisionId !== undefined))
      ? execution.afterBodyContentHash
      : null;
    await client.query(`UPDATE managed_knowledge_pages SET state = $2, expected_resync_content_hash = $3,
      version = version + 1, updated_at = $4 WHERE id = $1`, [page.id, pageState, expectedResyncHash, normalized.at]);
    await insertExecutionEvent(client, execution.id, normalized.classification, execution.version, execution.version + 1, normalized.operationKey, fingerprint, normalized.responseClassification ?? normalized.reconciliationReasonCode, normalized.at);
    await insertPageEvent(client, { pageId: page.id, eventType: pageState === "reconciliation_required" ? "reconciliation_required" : pageState === "blocked" ? "blocked" : pageState === "retired" ? "retired" : "remote_outcome_confirmed", fromVersion: page.version, toVersion: page.version + 1, operationKey: `${normalized.operationKey}:page`, fingerprint: operationFingerprint({ fingerprint, kind: "page" }), actor: normalized.actor, reasonCode: normalized.responseClassification ?? normalized.reconciliationReasonCode, at: normalized.at });
    const desiredProposalState = normalized.classification === "preflight_failed" || normalized.classification === "failed"
      ? "failed"
      : normalized.classification === "outcome_unknown" || normalized.classification === "reconciliation_required"
        ? "reconciliation_required"
        : undefined;
    if (desiredProposalState !== undefined && text(proposal.status) !== desiredProposalState) {
      const proposalVersion = number(proposal.version);
      await client.query(
        `UPDATE action_proposals SET status = $2,version = version + 1,updated_at = $3 WHERE id = $1`,
        [execution.proposalId, desiredProposalState, normalized.at],
      );
      await client.query(
        `INSERT INTO action_events (
           id,proposal_id,event_type,operation_key,from_version,to_version,reason_code,created_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [randomUUID(), execution.proposalId,
          desiredProposalState === "failed" ? "execution_failed" : "execution_reconciliation_required",
          `${normalized.operationKey}:proposal`, proposalVersion, proposalVersion + 1,
          normalized.responseClassification ?? normalized.reconciliationReasonCode ?? normalized.classification,
          normalized.at],
      );
    }
    return { outcome: "applied", execution: await requireExecution(client, execution.id), page: await requirePage(client, page.id) };
  });
}

async function findResyncReadyExecution(
  dataSource: PostgresKnowledgeDraftDataSource,
  input: { executionId?: string; observationId?: string },
): Promise<ManagedResyncReadyExecution | undefined> {
  const executionId = input.executionId === undefined ? undefined : ref("executionId", input.executionId);
  const observationId = input.observationId === undefined ? undefined : ref("observationId", input.observationId);
  if ((executionId === undefined) === (observationId === undefined)) {
    throw new Error("exactly one managed resync lookup identity is required");
  }
  const lookupColumn = executionId === undefined ? "observation.id" : "execution.id";
  const lookupValue = executionId ?? observationId!;
  const result = await dataSource.query<Record<string, unknown>>(
    `SELECT execution.id AS execution_id,
            execution.version AS execution_version,
            page.version AS managed_page_version,
            observation.id AS observation_id
       FROM knowledge_publication_update_executions execution
       JOIN managed_knowledge_pages page ON page.id = execution.managed_page_id
       JOIN knowledge_publication_update_targets target ON target.id = execution.update_target_id
       JOIN action_proposals proposal ON proposal.id = execution.proposal_id
       JOIN managed_knowledge_snapshot_observations observation
         ON observation.managed_page_id = page.id
        AND observation.document_source_id = page.linked_document_source_id
        AND observation.observed_managed_body_block_id = page.managed_body_block_id
        AND observation.observed_remote_revision_id = execution.response_revision_id
        AND observation.managed_body_content_hash = execution.after_body_content_hash
       JOIN document_sources source ON source.id = observation.document_source_id
       JOIN document_snapshots snapshot
         ON snapshot.id = observation.document_snapshot_id
        AND snapshot.document_source_id = observation.document_source_id
        AND snapshot.content_hash = observation.snapshot_content_hash
      WHERE ${lookupColumn} = $1
        AND page.state = 'resync_required'
        AND page.expected_resync_content_hash = execution.after_body_content_hash
        AND execution.state = 'remote_applied'
        AND proposal.status IN ('executing','reconciliation_required')
        AND target.managed_page_id = page.id
        AND target.linked_document_source_id = page.linked_document_source_id
        AND target.managed_body_block_id = page.managed_body_block_id
        AND observation.document_snapshot_id <> target.target_snapshot_id
        AND observation.managed_page_version BETWEEN execution.managed_page_version AND page.version
        AND observation.observed_block_type = 'text'
        AND snapshot.fetch_status = 'succeeded'
        AND snapshot.fetched_at >= execution.remote_request_dispatched_at
        AND source.permission_state IN ('readable','unknown')
        AND source.sync_state = 'synced'
        AND source.can_use_for_answering = TRUE
        AND source.can_use_for_knowledge_drafts = TRUE
        AND NOT EXISTS (
          SELECT 1 FROM knowledge_publication_update_executions newer
           WHERE newer.managed_page_id = page.id
             AND newer.id <> execution.id
             AND newer.state IN (
               'claimed','remote_request_dispatched','outcome_unknown','remote_applied',
               'resync_required','reconciliation_required'
             )
        )
      ORDER BY observation.observed_at DESC, observation.id ASC
      LIMIT 1`,
    [lookupValue],
  );
  if (result.rows.length !== 1) return undefined;
  return {
    executionId: text(result.rows[0]!.execution_id),
    executionVersion: number(result.rows[0]!.execution_version),
    managedPageVersion: number(result.rows[0]!.managed_page_version),
    observationId: text(result.rows[0]!.observation_id),
  };
}

async function completeResync(dataSource: PostgresKnowledgeDraftDataSource, input: CompleteManagedResyncInput): Promise<ManagedExecutionMutationResult> {
  const normalized = {
    executionId: ref("executionId", input.executionId),
    expectedExecutionVersion: positive("expectedExecutionVersion", input.expectedExecutionVersion),
    expectedManagedPageVersion: positive("expectedManagedPageVersion", input.expectedManagedPageVersion),
    observationId: ref("observationId", input.observationId),
    operationKey: ref("operationKey", input.operationKey),
    actor: ref("actor", input.actor),
    at: date("at", input.at),
  };
  const fingerprint = operationFingerprint(normalized);
  return withTransaction(dataSource, async (client) => {
    await lockOperation(client, normalized.operationKey);
    const event = await client.query<{ execution_id: string; operation_fingerprint: string }>(`SELECT execution_id, operation_fingerprint FROM knowledge_publication_update_execution_events WHERE operation_key = $1`, [normalized.operationKey]);
    if (event.rows[0] !== undefined) { if (event.rows[0].operation_fingerprint !== fingerprint) throw new ManagedKnowledgePageOperationConflictError(); const execution = await requireExecution(client, event.rows[0].execution_id); return { outcome: "already_applied", execution, page: await requirePage(client, execution.managedPageId) }; }
    const executionIdentity = await requireExecution(client, normalized.executionId);
    const page = await requirePageForUpdate(client, executionIdentity.managedPageId);
    const target = await requireTargetForUpdate(client, executionIdentity.updateTargetId);
    const proposalResult = await client.query<Record<string, unknown>>(
      `SELECT id,status,version FROM action_proposals WHERE id = $1 FOR UPDATE`,
      [executionIdentity.proposalId],
    );
    const proposal = proposalResult.rows[0];
    if (proposal === undefined) throw new ManagedKnowledgePageVersionConflictError();
    const execution = await requireExecutionForUpdate(client, normalized.executionId);
    const observation = await requireObservation(client, normalized.observationId);
    const readiness = await client.query<{ ready: boolean; approval_id: string }>(
      `SELECT TRUE AS ready,
              (SELECT approval.id
                 FROM action_approvals approval
                WHERE approval.proposal_id = $3
                ORDER BY approval.created_at DESC, approval.id ASC
                LIMIT 1) AS approval_id
         FROM document_sources source
         JOIN document_snapshots snapshot
           ON snapshot.id = $4
          AND snapshot.document_source_id = source.id
          AND snapshot.content_hash = $5
        WHERE source.id = $1
          AND source.permission_state IN ('readable','unknown')
          AND source.sync_state = 'synced'
          AND source.can_use_for_answering = TRUE
          AND source.can_use_for_knowledge_drafts = TRUE
          AND snapshot.fetch_status = 'succeeded'
          AND snapshot.fetched_at >= $6
          AND NOT EXISTS (
            SELECT 1 FROM knowledge_publication_update_executions newer
             WHERE newer.managed_page_id = $2
               AND newer.id <> $7
               AND newer.state IN (
                 'claimed','remote_request_dispatched','outcome_unknown','remote_applied',
                 'resync_required','reconciliation_required'
               )
          )
        FOR SHARE OF source,snapshot`,
      [observation.documentSourceId, page.id, execution.proposalId,
        observation.documentSnapshotId, observation.snapshotContentHash,
        execution.remoteRequestDispatchedAt, execution.id],
    );
    const ready = readiness.rows[0];
    if (
      execution.version !== normalized.expectedExecutionVersion ||
      page.version !== normalized.expectedManagedPageVersion ||
      execution.state !== "remote_applied" ||
      page.state !== "resync_required" ||
      page.expectedResyncContentHash !== execution.afterBodyContentHash ||
      !["executing", "reconciliation_required"].includes(text(proposal.status)) ||
      observation.managedPageId !== page.id ||
      observation.managedPageVersion < execution.managedPageVersion ||
      observation.managedPageVersion > page.version ||
      observation.documentSourceId !== page.linkedDocumentSourceId ||
      observation.documentSourceId !== target.linkedDocumentSourceId ||
      observation.documentSnapshotId === target.targetSnapshotId ||
      observation.observedManagedBodyBlockId !== page.managedBodyBlockId ||
      observation.observedManagedBodyBlockId !== target.managedBodyBlockId ||
      observation.managedBodyContentHash !== execution.afterBodyContentHash ||
      observation.observedRemoteRevisionId !== execution.responseRevisionId ||
      execution.remoteRequestDispatchedAt === undefined ||
      ready?.ready !== true || ready.approval_id === null || ready.approval_id === undefined
    ) throw new ManagedKnowledgePageVersionConflictError();
    const proposalVersion = number(proposal.version);
    await client.query(`UPDATE knowledge_publication_update_executions SET state = 'succeeded', version = version + 1, updated_at = $2 WHERE id = $1`, [execution.id, normalized.at]);
    await client.query(`UPDATE managed_knowledge_pages SET state = 'active', current_remote_revision_id = $2, current_body_content_hash = $3, expected_resync_content_hash = NULL, version = version + 1, updated_at = $4 WHERE id = $1`, [page.id, observation.observedRemoteRevisionId, observation.managedBodyContentHash, normalized.at]);
    await client.query(
      `INSERT INTO knowledge_publication_updates (
         id,origin_knowledge_publication_id,proposal_id,approval_id,draft_id,draft_revision,
         conflict_candidate_id,managed_page_id,document_source_id,execution_id,
         before_remote_revision_id,after_remote_revision_id,before_body_content_hash,
         after_body_content_hash,executor_id,operation_key,operation_fingerprint,completed_at,created_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$18)`,
      [randomUUID(), page.originKnowledgePublicationId, execution.proposalId, ready.approval_id,
        target.draftId, target.draftRevision, target.conflictCandidateId, page.id,
        observation.documentSourceId, execution.id, execution.expectedRemoteRevisionId,
        observation.observedRemoteRevisionId, execution.beforeBodyContentHash,
        execution.afterBodyContentHash, normalized.actor, `${normalized.operationKey}:success`,
        operationFingerprint({ fingerprint, kind: "immutable-update-success" }), normalized.at],
    );
    await client.query(
      `UPDATE action_proposals SET status = 'succeeded',version = version + 1,updated_at = $2 WHERE id = $1`,
      [execution.proposalId, normalized.at],
    );
    await insertExecutionEvent(client, execution.id, "succeeded", execution.version, execution.version + 1, normalized.operationKey, fingerprint, undefined, normalized.at);
    await insertPageEvent(client, { pageId: page.id, eventType: "resync_completed", fromVersion: page.version, toVersion: page.version + 1, operationKey: `${normalized.operationKey}:page`, fingerprint: operationFingerprint({ fingerprint, kind: "page" }), actor: normalized.actor, at: normalized.at });
    await client.query(
      `INSERT INTO action_events (
         id,proposal_id,event_type,operation_key,from_version,to_version,reason_code,created_at
       ) VALUES ($1,$2,'execution_succeeded',$3,$4,$5,NULL,$6)`,
      [randomUUID(), execution.proposalId, `${normalized.operationKey}:proposal`,
        proposalVersion, proposalVersion + 1, normalized.at],
    );
    return { outcome: "applied", execution: await requireExecution(client, execution.id), page: await requirePage(client, page.id) };
  });
}

async function listReconciliationRequired(dataSource: PostgresKnowledgeDraftDataSource, input: { limit: number; dispatchedBefore?: Date }): Promise<ClaimedManagedKnowledgeUpdate[]> {
  const cutoff = input.dispatchedBefore === undefined ? null : date("dispatchedBefore", input.dispatchedBefore);
  const result = await dataSource.query<ExecutionRow>(
    `${executionSelect()}
      WHERE state IN ('outcome_unknown','reconciliation_required','remote_applied')
         OR (state = 'remote_request_dispatched' AND $2 IS NOT NULL AND remote_request_dispatched_at <= $2)
      ORDER BY created_at ASC, id ASC
      LIMIT $1`,
    [limit(input.limit), cutoff],
  );
  const values: ClaimedManagedKnowledgeUpdate[] = [];
  for (const row of result.rows) {
    values.push(await buildClaimResult(dataSource, mapExecution(row), "applied"));
  }
  return values;
}

async function getSourceAvailability(dataSource: PostgresKnowledgeDraftDataSource, documentSourceId: string): Promise<"available" | "barred"> {
  const result = await dataSource.query<{ barred: boolean }>(`SELECT EXISTS (SELECT 1 FROM managed_knowledge_pages WHERE linked_document_source_id = $1 AND state <> 'active') AS barred`, [ref("documentSourceId", documentSourceId)]); return result.rows[0]?.barred === true ? "barred" : "available";
}

async function pageReplay(client: KnowledgeDraftTransactionClient, operationKey: string, fingerprint: string): Promise<ManagedKnowledgePage | undefined> { const result = await client.query<{ managed_page_id: string; operation_fingerprint: string }>(`SELECT managed_page_id, operation_fingerprint FROM managed_knowledge_page_events WHERE operation_key = $1`, [operationKey]); if (result.rows[0] === undefined) return undefined; if (result.rows[0].operation_fingerprint !== fingerprint) throw new ManagedKnowledgePageOperationConflictError(); return requirePage(client, result.rows[0].managed_page_id); }
async function requirePage(queryable: Pick<PostgresKnowledgeDraftDataSource, "query">, id: string): Promise<ManagedKnowledgePage> { const result = await queryable.query<PageRow>(`${pageSelect()} WHERE id = $1`, [id]); if (result.rows[0] === undefined) throw new ManagedKnowledgePageVersionConflictError(); return mapPage(result.rows[0]); }
async function requirePageForUpdate(client: KnowledgeDraftTransactionClient, id: string): Promise<ManagedKnowledgePage> { const result = await client.query<PageRow>(`${pageSelect()} WHERE id = $1 FOR UPDATE`, [id]); if (result.rows[0] === undefined) throw new ManagedKnowledgePageVersionConflictError(); return mapPage(result.rows[0]); }
async function requireTarget(queryable: Pick<PostgresKnowledgeDraftDataSource, "query">, id: string): Promise<ManagedKnowledgeUpdateTarget> { const result = await queryable.query<TargetRow>(`${targetSelect()} WHERE id = $1`, [id]); if (result.rows[0] === undefined) throw new ManagedKnowledgePageVersionConflictError(); return mapTarget(result.rows[0]); }
async function requireTargetForProposal(queryable: Pick<PostgresKnowledgeDraftDataSource, "query">, proposalId: string): Promise<ManagedKnowledgeUpdateTarget> { const result = await queryable.query<TargetRow>(`${targetSelect()} target JOIN action_proposals proposal ON proposal.subject_id = target.draft_id AND proposal.subject_revision = target.draft_revision AND proposal.subject_version = target.draft_version WHERE proposal.id = $1`, [proposalId]); if (result.rows.length !== 1) throw new ManagedKnowledgePageVersionConflictError(); return mapTarget(result.rows[0]); }
async function requireTargetForUpdate(client: KnowledgeDraftTransactionClient, id: string): Promise<ManagedKnowledgeUpdateTarget> { const result = await client.query<TargetRow>(`${targetSelect()} WHERE id = $1 FOR UPDATE`, [id]); if (result.rows[0] === undefined) throw new ManagedKnowledgePageVersionConflictError(); return mapTarget(result.rows[0]); }
async function requireExecution(queryable: Pick<PostgresKnowledgeDraftDataSource, "query">, id: string): Promise<ManagedKnowledgeUpdateExecution> { const result = await queryable.query<ExecutionRow>(`${executionSelect()} WHERE id = $1`, [id]); if (result.rows[0] === undefined) throw new ManagedKnowledgePageVersionConflictError(); return mapExecution(result.rows[0]); }
async function requireExecutionForUpdate(client: KnowledgeDraftTransactionClient, id: string): Promise<ManagedKnowledgeUpdateExecution> { const result = await client.query<ExecutionRow>(`${executionSelect()} WHERE id = $1 FOR UPDATE`, [id]); if (result.rows[0] === undefined) throw new ManagedKnowledgePageVersionConflictError(); return mapExecution(result.rows[0]); }
async function requireObservation(queryable: Pick<PostgresKnowledgeDraftDataSource, "query">, id: string): Promise<ManagedSnapshotObservation> { const result = await queryable.query<ObservationRow>(`${observationSelect()} WHERE id = $1`, [id]); if (result.rows[0] === undefined) throw new ManagedKnowledgePageVersionConflictError(); return mapObservation(result.rows[0]); }
async function insertPageEvent(client: KnowledgeDraftTransactionClient, value: { pageId: string; eventType: string; fromVersion?: number; toVersion: number; operationKey: string; fingerprint: string; actor?: string; reasonCode?: string; at: Date }): Promise<void> { await client.query(`INSERT INTO managed_knowledge_page_events (id,managed_page_id,event_type,from_version,to_version,operation_key,operation_fingerprint,actor,reason_code,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [randomUUID(),value.pageId,value.eventType,value.fromVersion ?? null,value.toVersion,value.operationKey,value.fingerprint,value.actor ?? null,value.reasonCode ?? null,value.at]); }
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
function normalizeOutcomeInput(input: RecordManagedRemoteOutcomeInput): RecordManagedRemoteOutcomeInput { const classification = input.classification; if (!['preflight_failed','outcome_unknown','remote_applied','failed','reconciliation_required'].includes(classification)) throw new Error('classification is invalid'); if (!['active','resync_required','reconciliation_required','blocked','retired'].includes(input.pageDisposition)) throw new Error('pageDisposition is invalid'); if ((classification === 'outcome_unknown' || classification === 'reconciliation_required') && input.reconciliationReasonCode === undefined) throw new Error('reconciliationReasonCode is required'); return { ...input,executionId:ref('executionId',input.executionId),expectedExecutionVersion:positive('expectedExecutionVersion',input.expectedExecutionVersion),pageDisposition:input.pageDisposition,...(input.responseClassification === undefined ? {} : {responseClassification:ref('responseClassification',input.responseClassification)}),...(input.responseRevisionId === undefined ? {} : {responseRevisionId:ref('responseRevisionId',input.responseRevisionId)}),...(input.reconciliationReasonCode === undefined ? {} : {reconciliationReasonCode:ref('reconciliationReasonCode',input.reconciliationReasonCode)}),...(input.verifiedUnchangedRemote === undefined ? {} : { verifiedUnchangedRemote: { remoteDocumentToken: ref('verifiedUnchangedRemote.remoteDocumentToken',input.verifiedUnchangedRemote.remoteDocumentToken), managedBodyBlockId: ref('verifiedUnchangedRemote.managedBodyBlockId',input.verifiedUnchangedRemote.managedBodyBlockId), remoteRevisionId: ref('verifiedUnchangedRemote.remoteRevisionId',input.verifiedUnchangedRemote.remoteRevisionId), bodyContentHash: hash('verifiedUnchangedRemote.bodyContentHash',input.verifiedUnchangedRemote.bodyContentHash) } }),operationKey:ref('operationKey',input.operationKey),actor:ref('actor',input.actor),at:date('at',input.at) }; }
function validOutcomePredecessor(state: ManagedKnowledgeUpdateExecution["state"], classification: RecordManagedRemoteOutcomeInput["classification"]): boolean {
  if (classification === "preflight_failed") return state === "claimed";
  if (classification === "outcome_unknown") return state === "remote_request_dispatched";
  if (classification === "remote_applied") return ["remote_request_dispatched", "outcome_unknown", "reconciliation_required"].includes(state);
  if (classification === "failed") return ["remote_request_dispatched", "outcome_unknown", "reconciliation_required"].includes(state);
  return ["remote_request_dispatched", "outcome_unknown", "remote_applied", "reconciliation_required"].includes(state);
}
function validPageDisposition(classification: RecordManagedRemoteOutcomeInput["classification"], disposition: RecordManagedRemoteOutcomeInput["pageDisposition"]): boolean {
  if (classification === "remote_applied") return disposition === "resync_required";
  if (classification === "outcome_unknown" || classification === "reconciliation_required") return disposition === "reconciliation_required";
  if (classification === "preflight_failed") return disposition === "active" || disposition === "reconciliation_required" || disposition === "blocked" || disposition === "retired";
  return disposition === "reconciliation_required" || disposition === "blocked" || disposition === "retired";
}
function normalizeClaimInput(input: ClaimManagedUpdateInput): ClaimManagedUpdateInput {
  if (typeof input.runtimeGate !== "object" || input.runtimeGate === null) {
    throw new Error("runtimeGate is invalid");
  }
  for (const field of ["deploymentEnabled", "globalEnabled", "writeKnowledgeBase", "updateManagedKnowledge"] as const) {
    if (typeof input.runtimeGate[field] !== "boolean") throw new Error("runtimeGate is invalid");
  }
  return {
    proposalId: ref("proposalId", input.proposalId),
    expectedProposalVersion: positive("expectedProposalVersion", input.expectedProposalVersion),
    runtimeGate: {
      deploymentEnabled: input.runtimeGate.deploymentEnabled,
      globalEnabled: input.runtimeGate.globalEnabled,
      writeKnowledgeBase: input.runtimeGate.writeKnowledgeBase,
      updateManagedKnowledge: input.runtimeGate.updateManagedKnowledge,
      disabledGroupIds: referenceList("disabledGroupIds", input.runtimeGate.disabledGroupIds),
      allowedGroupIds: referenceList("allowedGroupIds", input.runtimeGate.allowedGroupIds),
    },
    operationKey: ref("operationKey", input.operationKey),
    workerId: ref("workerId", input.workerId),
    at: date("at", input.at),
  };
}
function managedUpdateActionTargetFingerprint(input: { proposalId: string; proposalVersion: number; target: ManagedKnowledgeUpdateTarget }): string {
  const target = input.target;
  return createHash("sha256").update(JSON.stringify([
    ["action_type", "update_knowledge_publication"],
    ["proposal_id", input.proposalId],
    ["proposal_version", input.proposalVersion],
    ["draft_id", target.draftId],
    ["draft_revision", target.draftRevision],
    ["proposed_content_hash", target.proposedBodyContentHash],
    ["conflict_candidate_id", target.conflictCandidateId],
    ["candidate_version", target.conflictCandidateVersion],
    ["managed_page_id", target.managedPageId],
    ["managed_page_version", target.managedPageVersion],
    ["document_source_id", target.linkedDocumentSourceId],
    ["target_snapshot_id", target.targetSnapshotId],
    ["target_snapshot_hash", target.targetSnapshotHash],
    ["remote_document_token", target.remoteDocumentToken],
    ["managed_body_block_id", target.managedBodyBlockId],
    ["expected_remote_revision", target.expectedRemoteRevisionId],
    ["current_body_content_hash", target.currentBodyContentHash],
    ["target_policy_id", target.targetPolicyId],
    ["target_policy_version", target.targetPolicyVersion],
    ["authorization_group_id", target.authorizationGroupId],
  ])).digest("hex");
}
async function buildClaimResult(queryable: Pick<PostgresKnowledgeDraftDataSource, "query">, execution: ManagedKnowledgeUpdateExecution, outcome: "applied" | "already_applied"): Promise<ClaimedManagedKnowledgeUpdate> {
  const target = await requireTarget(queryable, execution.updateTargetId);
  const proposal = await requireClaimProposal(queryable, execution.proposalId);
  const draft = await requireClaimDraft(queryable, target.draftId, target.draftRevision);
  if (canonicalManagedBodyHash(draft.content) !== execution.afterBodyContentHash) {
    throw new ManagedKnowledgePageOperationConflictError();
  }
  return { outcome, execution, target, proposal, draft, page: await requirePage(queryable, execution.managedPageId) };
}
async function requireClaimProposal(queryable: Pick<PostgresKnowledgeDraftDataSource, "query">, id: string) {
  const result = await queryable.query<Record<string, unknown>>(
    `SELECT id,action_type,subject_type,subject_id,subject_revision,subject_version,
            target_policy_id,target_policy_version,risk_level,status,operation_key,
            operation_fingerprint,version,created_at,updated_at
     FROM action_proposals WHERE id = $1`,
    [id],
  );
  if (result.rows[0] === undefined) throw new ManagedKnowledgePageVersionConflictError();
  return mapClaimProposal(result.rows[0]);
}
async function requireClaimDraft(queryable: Pick<PostgresKnowledgeDraftDataSource, "query">, id: string, revision: number) {
  const result = await queryable.query<Record<string, unknown>>(
    `SELECT draft.id,draft.source_group_id,draft.version,revision.revision_number,
            revision.content,revision.risk_level
     FROM knowledge_drafts draft JOIN knowledge_draft_revisions revision ON revision.draft_id = draft.id
     WHERE draft.id = $1 AND revision.revision_number = $2`,
    [id, revision],
  );
  if (result.rows[0] === undefined) throw new ManagedKnowledgePageVersionConflictError();
  return mapClaimDraft(result.rows[0]);
}
function mapClaimProposal(row: Record<string, unknown>) {
  return {
    id: text(row.id),
    actionType: text(row.action_type) as "update_knowledge_publication",
    subjectType: "knowledge_draft" as const,
    subjectId: text(row.subject_id),
    subjectRevision: number(row.subject_revision),
    subjectVersion: number(row.subject_version),
    targetPolicyId: text(row.target_policy_id),
    targetPolicyVersion: number(row.target_policy_version),
    riskLevel: text(row.risk_level) as "low" | "medium" | "high",
    status: text(row.status) as "approved" | "executing" | "reconciliation_required" | "succeeded" | "failed",
    operationKey: text(row.operation_key),
    version: number(row.version),
    createdAt: date("created_at", row.created_at),
    updatedAt: date("updated_at", row.updated_at),
  };
}
function mapClaimDraft(row: Record<string, unknown>) {
  return {
    id: text(row.id),
    sourceGroupId: text(row.source_group_id),
    revisionNumber: number(row.revision_number ?? row.current_revision_number),
    version: number(row.version),
    content: text(row.content),
    riskLevel: text(row.risk_level) as "low" | "medium" | "high",
  };
}
function stableUuid(value: string): string {
  const bytes = createHash("sha256").update(value).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hexValue = bytes.toString("hex");
  return `${hexValue.slice(0, 8)}-${hexValue.slice(8, 12)}-${hexValue.slice(12, 16)}-${hexValue.slice(16, 20)}-${hexValue.slice(20)}`;
}
function referenceList(name: string, value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 100) throw new Error(`${name} is invalid`);
  const normalized = value.map((item) => ref(name, item));
  if (new Set(normalized).size !== normalized.length) throw new Error(`${name} is invalid`);
  return normalized.sort();
}
function nullableText(value: unknown): string | undefined { return value === null || value === undefined ? undefined : text(value); }
function stringArray(value: unknown): string[] { if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error("database row is invalid"); return value as string[]; }
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
