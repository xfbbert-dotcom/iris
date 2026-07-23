import { createHash, randomUUID } from "node:crypto";

import {
  KNOWLEDGE_DRAFT_REFERENCE_MAX_CHARS,
  KNOWLEDGE_DRAFT_RISK_LEVELS,
  KNOWLEDGE_DRAFT_STATUSES,
  type KnowledgeDraftEvidenceReference,
  type KnowledgeDraftReviewer,
  type KnowledgeDraftRiskLevel,
  type KnowledgeDraftStatus,
} from "../knowledge-governance/knowledge-draft.js";
import {
  findInvalidKnowledgeDraftEvidence,
  validateCurrentKnowledgeDraftEvidence,
} from "../knowledge-governance/postgres-knowledge-draft-evidence.js";
import type {
  KnowledgeDraftTransactionClient,
  PostgresKnowledgeDraftDataSource,
} from "../knowledge-governance/postgres-knowledge-draft-repository.js";

import {
  ACTION_PROPOSAL_STATUSES,
  ACTION_ROLE_GRANT_TYPES,
  buildApprovalRequirementSnapshot,
  type ActionApprovalRequirementSnapshot,
  type ActionApprovalRequirementKind,
  type ActionApprovalRoleRefType,
  type ActionProposal,
  type ActionProposalStatus,
  type ActionRoleGrantType,
} from "./action-proposal.js";
import type {
  ActionApproval,
  ActionApprovalDeliveryContext,
  ActionApprovalOutboxStatusCounts,
  ActionApprovalPresentation,
  ActionApprovalReplayInspection,
  ActionApprovalRequirement,
  ActionApprovalSendClaim,
  ActionReviewContext,
  ActionProposalContext,
  ActionProposalDraftCandidate,
  ActionProposalEvent,
  ActionProposalMutationResult,
  ActionProposalRepository,
  ActionProposalStatusCounts,
  ActionRoleGrant,
  ApplyActionProposalActionInput,
  ApplyActionProposalActionResult,
  ApplyActionProposalGovernanceDispositionInput,
  ApplyActionProposalGovernanceDispositionResult,
  CancelStaleActionProposalsInput,
  CancelStaleActionProposalsResult,
  ClaimApprovedPublicationExecutionInput,
  ClaimApprovedPublicationExecutionResult,
  ClaimedPublicationDraft,
  CompletePublicationExecutionInput,
  CompletePublicationExecutionResult,
  CreateActionProposalInput,
  KnowledgePublication,
  PolicyMutationResult,
  PreflightActionApprovalInput,
  PublicationExecution,
  PublicationExecutionState,
  PublicationTargetPolicy,
  CurrentActionReviewAttestationInput,
  RecordActionReviewAttestationInput,
  RoleGrantMutationResult,
  UpsertActionRoleGrantInput,
  UpsertPublicationTargetPolicyInput,
} from "./action-proposal-repository.js";

type PolicyRow = {
  id: string;
  space_id: string;
  parent_node_token: string | null;
  display_name: string;
  allowed_group_ids: string[];
  allowed_risk_levels: KnowledgeDraftRiskLevel[];
  enabled: boolean;
  version: string | number;
  created_at: Date;
  updated_at: Date;
};

type GrantRow = {
  role_type: ActionRoleGrantType;
  actor_open_id: string;
  enabled: boolean;
  version: string | number;
  created_at: Date;
  updated_at: Date;
};

type ProposalRow = {
  id: string;
  action_type: "publish_knowledge_draft";
  subject_type: "knowledge_draft";
  subject_id: string;
  subject_revision: string | number;
  subject_version: string | number;
  target_policy_id: string;
  target_policy_version: string | number;
  risk_level: KnowledgeDraftRiskLevel;
  status: ActionProposalStatus;
  operation_key: string;
  operation_fingerprint: string;
  version: string | number;
  created_at: Date;
  updated_at: Date;
};

type RequirementRow = {
  id: string;
  proposal_id: string;
  requirement_kind: ActionApprovalRequirementKind;
  role_ref_type: ActionApprovalRoleRefType;
  role_ref: string | null;
  target_policy_id: string;
  target_policy_version: string | number;
  state: "pending" | "satisfied" | "invalidated";
  satisfied_actor_open_id: string | null;
  satisfied_source_type: "group_confirmation" | "action_approval" | null;
  satisfied_source_id: string | null;
  version: string | number;
  created_at: Date;
  updated_at: Date;
};

type ApprovalRow = {
  id: string;
  proposal_id: string;
  requirement_id: string;
  actor_open_id: string;
  source_presentation_id: string;
  callback_event_id: string;
  subject_revision: string | number;
  subject_version: string | number;
  operation_key: string;
  operation_fingerprint: string;
  created_at: Date;
};

type ApprovalPresentationRow = {
  id: string;
  proposal_id: string;
  requirement_id: string;
  proposal_version: string | number;
  recipient_open_id: string;
  state: "pending_send" | "active" | "superseded" | "closed" | "send_failed";
  message_id: string | null;
  operation_key: string;
  version: string | number;
  created_at: Date;
  activated_at: Date | null;
  closed_at: Date | null;
};

type ApprovalOutboxRow = {
  id: string;
  presentation_id: string;
  idempotency_key: string;
  state: "pending" | "processing" | "external_attempting" | "sent" | "failed" | "outcome_unknown";
  attempts: number;
  worker_id: string | null;
  lease_until: Date | null;
  retry_at: Date | null;
  error_code: string | null;
  created_at: Date;
  updated_at: Date;
};

type DraftRevisionRow = {
  id: string;
  source_group_id: string | null;
  status: string;
  current_revision_number: string | number;
  version: string | number;
  title: string;
  content: string;
  risk_level: KnowledgeDraftRiskLevel;
  reviewer_type: "feishu_user" | "text_label" | "admin_role" | null;
  reviewer_ref: string | null;
  suggested_space_id: string | null;
  suggested_parent_node_token: string | null;
};

type DraftCandidateRow = DraftRevisionRow & {
  has_current_group_confirmation: boolean;
  updated_at: Date;
};

type EvidenceRow = {
  evidence_type: "conversation_message" | "discussion_thread" | "action_item" | "document_source";
  reference_id: string;
  source_group_id: string | null;
  entity_version: string | number | null;
  source_updated_at: Date | null;
};

type GroupConfirmationRow = {
  actor_open_id: string;
  presentation_id: string;
};

type OperationRow = {
  operation_fingerprint: string;
  resulting_version: string | number;
};

type ActionEventRow = {
  id: string;
  proposal_id: string;
  event_type: ActionProposalEvent["eventType"];
  actor_open_id: string | null;
  from_version: string | number | null;
  to_version: string | number;
  reason_code: string | null;
  created_at: Date;
};

type ActionReviewAttestationRow = {
  proposal_id: string;
  actor_open_id: string;
  subject_revision: string | number;
  subject_version: string | number;
  proposal_version: string | number;
  content_hash: string;
  session_id_hash: string;
  operation_key: string;
  operation_fingerprint: string;
};

type PublicationExecutionRow = {
  id: string;
  proposal_id: string;
  attempt_number: string | number;
  state: PublicationExecutionState;
  request_fingerprint: string;
  provider: "feishu_wiki";
  response_classification: string | null;
  remote_node_token: string | null;
  remote_document_token: string | null;
  version: string | number;
  retry_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

type KnowledgePublicationRow = {
  id: string;
  proposal_id: string;
  execution_id: string;
  draft_id: string;
  revision_number: string | number;
  draft_version: string | number;
  target_policy_id: string;
  target_policy_version: string | number;
  space_id: string;
  remote_node_token: string;
  remote_document_token: string;
  remote_document_type: string;
  remote_document_version: string | number | null;
  content_hash: string;
  permission_check_summary: string;
  operation_key: string;
  published_at: Date;
  created_at: Date;
};

export class ActionProposalOperationConflictError extends Error {
  constructor() {
    super("action proposal operation conflict");
    this.name = "ActionProposalOperationConflictError";
  }
}

export class ActionProposalVersionConflictError extends Error {
  constructor() {
    super("action proposal version conflict");
    this.name = "ActionProposalVersionConflictError";
  }
}

export class ActionProposalPersistenceConflictError extends Error {
  constructor() {
    super("action proposal persistence conflict");
    this.name = "ActionProposalPersistenceConflictError";
  }
}

export class ActionProposalIneligibleError extends Error {
  constructor() {
    super("action proposal subject is ineligible");
    this.name = "ActionProposalIneligibleError";
  }
}

export class ActionProposalAuthorizationError extends Error {
  constructor() {
    super("action proposal actor is not authorized");
    this.name = "ActionProposalAuthorizationError";
  }
}

export class ActionProposalReviewRequiredError extends Error {
  constructor() {
    super("action proposal review is required");
    this.name = "ActionProposalReviewRequiredError";
  }
}

export function createPostgresActionProposalRepository({
  dataSource,
}: {
  dataSource: PostgresKnowledgeDraftDataSource;
}): ActionProposalRepository {
  return {
    upsertTargetPolicy(input) {
      return upsertTargetPolicy(dataSource, input);
    },
    upsertRoleGrant(input) {
      return upsertRoleGrant(dataSource, input);
    },
    async actorHasCurrentRole(input) {
      const result = await dataSource.query<{ present: boolean }>(
        `SELECT EXISTS (
          SELECT 1 FROM action_role_grants
          WHERE role_type = $1 AND actor_open_id = $2 AND enabled = TRUE
        ) AS present`,
        [requireRoleType(input.roleType), requireReference("actorOpenId", input.actorOpenId)],
      );
      return result.rows[0]?.present === true;
    },
    createProposal(input) {
      return createProposal(dataSource, input);
    },
    cancelStaleProposals(input) {
      return cancelStaleProposals(dataSource, input);
    },
    applyApprovalAction(input) {
      return applyApprovalAction(dataSource, input);
    },
    applyGovernanceDisposition(input) {
      return applyGovernanceDisposition(dataSource, input);
    },
    claimApprovedPublicationExecution(input) {
      return claimApprovedPublicationExecution(dataSource, input);
    },
    completePublicationExecution(input) {
      return completePublicationExecution(dataSource, input);
    },
    inspectApprovalActionReplay(input) {
      return inspectApprovalActionReplay(dataSource, input);
    },
    preflightApprovalAction(input) {
      return preflightApprovalAction(dataSource, input);
    },
    getAuthorizedReviewContext(input) {
      return getAuthorizedReviewContext(dataSource, input);
    },
    recordReviewAttestation(input) {
      return recordReviewAttestation(dataSource, input);
    },
    hasCurrentReviewAttestation(input) {
      return hasCurrentReviewAttestation(dataSource, input);
    },
    async hasActionReviewMigration() {
      const result = await dataSource.query<{ present: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM schema_migrations
           WHERE name = '0034_action_review_attestations.sql'
         ) AS present`,
      );
      return result.rows[0]?.present === true;
    },
    async listApprovalPresentations(input) {
      const afterId = input.afterId === undefined
        ? undefined
        : requireReference("afterId", input.afterId);
      const result = await dataSource.query<ApprovalPresentationRow>(
        `${approvalPresentationSelect()} WHERE proposal_id = $1
           AND ($2::TEXT IS NULL OR id > $2)
         ORDER BY id ASC LIMIT $3`,
        [requireReference("proposalId", input.proposalId), afterId ?? null, requireLimit(input.limit)],
      );
      return result.rows.map(mapApprovalPresentation);
    },
    claimApprovalPresentationSend(input) {
      return claimApprovalPresentationSend(dataSource, input);
    },
    getApprovalDeliveryContext(id) {
      return getApprovalDeliveryContext(dataSource, requireReference("id", id));
    },
    beginApprovalExternalAttempt(input) {
      return beginApprovalExternalAttempt(dataSource, input);
    },
    failApprovalPresentationPreparation(input) {
      return failApprovalPresentationPreparation(dataSource, input);
    },
    completeApprovalPresentationSend(input) {
      return completeApprovalPresentationSend(dataSource, input);
    },
    failApprovalPresentationSend(input) {
      return failApprovalPresentationSend(dataSource, input);
    },
    async getApprovalOutboxStatusCounts() {
      const result = await dataSource.query<{
        pending: string | number;
        processing: string | number;
        external_attempting: string | number;
        sent: string | number;
        failed: string | number;
        outcome_unknown: string | number;
        terminal_failed: string | number;
      }>(
        `SELECT
           count(*) FILTER (WHERE state = 'pending') AS pending,
           count(*) FILTER (WHERE state = 'processing') AS processing,
           count(*) FILTER (WHERE state = 'external_attempting') AS external_attempting,
           count(*) FILTER (WHERE state = 'sent') AS sent,
           count(*) FILTER (WHERE state = 'failed') AS failed,
           count(*) FILTER (WHERE state = 'outcome_unknown') AS outcome_unknown,
           count(*) FILTER (
             WHERE state = 'failed'
               AND error_code IS DISTINCT FROM 'governance_disposition'
               AND error_code IS DISTINCT FROM 'presentation_superseded'
           ) AS terminal_failed
         FROM action_approval_presentation_outbox`,
      );
      const row = result.rows[0];
      if (row === undefined) throw new Error("action approval outbox status unavailable");
      return {
        pending: approvalStatusCount(row.pending),
        processing: approvalStatusCount(row.processing),
        external_attempting: approvalStatusCount(row.external_attempting),
        sent: approvalStatusCount(row.sent),
        failed: approvalStatusCount(row.failed),
        outcome_unknown: approvalStatusCount(row.outcome_unknown),
        terminalFailed: approvalStatusCount(row.terminal_failed),
      } satisfies ActionApprovalOutboxStatusCounts;
    },
    getProposal(id) {
      return loadProposalContext(dataSource, requireReference("id", id));
    },
    async listEligibleDrafts(input) {
      const groupIds = input.groupIds === undefined
        ? undefined
        : normalizeReferenceList("groupIds", input.groupIds, true);
      if (groupIds?.length === 0) return [];
      const result = await dataSource.query<DraftCandidateRow>(
        `SELECT draft.id, draft.source_group_id, draft.status, draft.current_revision_number,
                draft.version, revision.risk_level, revision.reviewer_type, revision.reviewer_ref,
                revision.suggested_space_id, revision.suggested_parent_node_token,
                EXISTS (
                  SELECT 1 FROM knowledge_draft_group_confirmations confirmation
                  WHERE confirmation.draft_id = draft.id
                    AND confirmation.revision_number = draft.current_revision_number
                ) AS has_current_group_confirmation,
                draft.updated_at
         FROM knowledge_drafts draft
         JOIN knowledge_draft_revisions revision
           ON revision.draft_id = draft.id
          AND revision.revision_number = draft.current_revision_number
         WHERE draft.status = 'pending_review'
           AND ($1::TEXT[] IS NULL OR draft.source_group_id = ANY($1))
         ORDER BY draft.updated_at ASC, draft.id ASC
         LIMIT $2`,
        [groupIds ?? null, requireLimit(input.limit)],
      );
      const candidates: ActionProposalDraftCandidate[] = [];
      for (const row of result.rows) {
        const evidence = await loadDraftEvidence(dataSource, row.id, Number(row.current_revision_number));
        const invalidReason = await findInvalidKnowledgeDraftEvidence({
          queryable: dataSource,
          sourceGroupId: row.source_group_id ?? undefined,
          evidence,
        });
        const reviewer = mapReviewer(row);
        const suggestedPublication = row.suggested_space_id === null &&
          row.suggested_parent_node_token === null
          ? undefined
          : {
              ...(row.suggested_space_id === null ? {} : { spaceId: row.suggested_space_id }),
              ...(row.suggested_parent_node_token === null
                ? {}
                : { parentNodeToken: row.suggested_parent_node_token }),
            };
        candidates.push({
          id: row.id,
          ...(row.source_group_id === null ? {} : { sourceGroupId: row.source_group_id }),
          currentRevision: Number(row.current_revision_number),
          version: Number(row.version),
          riskLevel: row.risk_level,
          ...(reviewer === undefined ? {} : { reviewer }),
          ...(suggestedPublication === undefined ? {} : { suggestedPublication }),
          evidenceState: invalidReason === undefined
            ? { status: "current" }
            : { status: "invalidated", reason: invalidReason },
          hasCurrentGroupConfirmation: row.has_current_group_confirmation,
          updatedAt: requireDate(row.updated_at),
        });
      }
      return candidates;
    },
    async listEvents(id) {
      const result = await dataSource.query<ActionEventRow>(
        `${actionEventSelect()} WHERE proposal_id = $1 ORDER BY created_at ASC, to_version ASC, id ASC`,
        [requireReference("id", id)],
      );
      return result.rows.map(mapActionEvent);
    },
    async listProposals(input) {
      const statuses = normalizeStatusFilter(input.statuses);
      const subjectId = input.subjectId === undefined
        ? undefined
        : requireReference("subjectId", input.subjectId);
      const result = await dataSource.query<ProposalRow>(
        `${proposalSelect()}
         WHERE ($1::TEXT[] IS NULL OR status = ANY($1::TEXT[]))
           AND ($2::TEXT IS NULL OR subject_id = $2)
         ORDER BY updated_at DESC, id ASC LIMIT $3`,
        [statuses ?? null, subjectId ?? null, requireLimit(input.limit)],
      );
      return result.rows.map(mapProposal);
    },
    async getStatusCounts() {
      const result = await dataSource.query<{ status: ActionProposalStatus; count: string | number }>(
        "SELECT status, count(*) AS count FROM action_proposals GROUP BY status",
      );
      const counts = Object.fromEntries(
        ACTION_PROPOSAL_STATUSES.map((status) => [status, 0]),
      ) as ActionProposalStatusCounts;
      for (const row of result.rows) counts[row.status] = Number(row.count);
      return counts;
    },
    async getTargetPolicy(id) {
      const result = await dataSource.query<PolicyRow>(`${policySelect()} WHERE id = $1`, [
        requireReference("id", id),
      ]);
      return result.rows[0] === undefined ? undefined : mapPolicy(result.rows[0]);
    },
    async listTargetPolicies(input) {
      const result = await dataSource.query<PolicyRow>(
        `${policySelect()} WHERE ($1::BOOLEAN IS NULL OR enabled = $1)
         ORDER BY updated_at DESC, id ASC LIMIT $2`,
        [input.enabled ?? null, requireLimit(input.limit)],
      );
      return result.rows.map(mapPolicy);
    },
    async listRoleGrants(input) {
      const roleType = input.roleType === undefined ? undefined : requireRoleType(input.roleType);
      const result = await dataSource.query<GrantRow>(
        `${grantSelect()} WHERE ($1::TEXT IS NULL OR role_type = $1)
          AND ($2::BOOLEAN IS NULL OR enabled = $2)
         ORDER BY updated_at DESC, role_type ASC, actor_open_id ASC LIMIT $3`,
        [roleType ?? null, input.enabled ?? null, requireLimit(input.limit)],
      );
      return result.rows.map(mapGrant);
    },
  };
}

function approvalStatusCount(value: string | number): number {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error("invalid action approval status count");
  }
  return count;
}

async function claimApprovalPresentationSend(
  dataSource: PostgresKnowledgeDraftDataSource,
  input: { workerId: string; leaseUntil: Date; at: Date },
): Promise<ActionApprovalSendClaim | undefined> {
  const workerId = requireReference("workerId", input.workerId);
  const at = requireDate(input.at);
  const leaseUntil = requireDate(input.leaseUntil);
  if (leaseUntil.getTime() <= at.getTime()) throw new Error("leaseUntil is invalid");
  return withTransaction(dataSource, async (client) => {
    const selected = await client.query<ApprovalOutboxRow>(
      `${approvalOutboxSelect("outbox")}
       JOIN action_approval_presentations presentation
         ON presentation.id = outbox.presentation_id
       WHERE presentation.state = 'pending_send'
         AND (
           (outbox.state = 'pending' AND (outbox.retry_at IS NULL OR outbox.retry_at <= $1))
           OR (outbox.state = 'processing' AND outbox.lease_until <= $1)
         )
       ORDER BY outbox.created_at ASC, outbox.id ASC
       FOR UPDATE OF presentation SKIP LOCKED
       LIMIT 1`,
      [at],
    );
    const selectedOutbox = selected.rows[0];
    if (selectedOutbox === undefined) return undefined;
    const presentation = await lockApprovalPresentation(client, selectedOutbox.presentation_id);
    const outbox = await lockApprovalOutbox(client, selectedOutbox.presentation_id);
    if (!isApprovalOutboxClaimable(outbox, at)) return undefined;
    const updated = await client.query<{ attempts: number }>(
      `UPDATE action_approval_presentation_outbox
       SET state = 'processing', attempts = attempts + 1, worker_id = $2,
           lease_until = $3, retry_at = NULL, error_code = NULL, updated_at = $4
       WHERE id = $1
       RETURNING attempts`,
      [outbox.id, workerId, leaseUntil, at],
    );
    return {
      presentation: mapApprovalPresentation(presentation),
      workerId,
      leaseUntil,
      attempts: updated.rows[0]?.attempts ?? outbox.attempts + 1,
    };
  });
}

function isApprovalOutboxClaimable(outbox: ApprovalOutboxRow, at: Date): boolean {
  if (outbox.state === "pending") {
    return outbox.retry_at === null || outbox.retry_at.getTime() <= at.getTime();
  }
  return outbox.state === "processing" &&
    outbox.lease_until !== null &&
    outbox.lease_until.getTime() <= at.getTime();
}

async function preflightApprovalAction(
  dataSource: PostgresKnowledgeDraftDataSource,
  input: PreflightActionApprovalInput,
): Promise<{ sourceGroupId?: string }> {
  const normalized = {
    proposalId: requireReference("proposalId", input.proposalId),
    requirementId: requireReference("requirementId", input.requirementId),
    expectedProposalVersion: requirePositiveInteger("expectedProposalVersion", input.expectedProposalVersion),
    expectedSubjectRevision: requirePositiveInteger("expectedSubjectRevision", input.expectedSubjectRevision),
    expectedSubjectVersion: requirePositiveInteger("expectedSubjectVersion", input.expectedSubjectVersion),
    expectedTargetPolicyVersion: requirePositiveInteger(
      "expectedTargetPolicyVersion",
      input.expectedTargetPolicyVersion,
    ),
    sourcePresentationId: requireReference("sourcePresentationId", input.sourcePresentationId),
    actorOpenId: requireReference("actorOpenId", input.actorOpenId),
    action: requireApprovalAction(input.action),
    requireReviewAttestation: requireBoolean(
      "requireReviewAttestation",
      input.requireReviewAttestation,
    ),
  };
  return withTransaction(dataSource, async (client) => {
    const proposal = await lockProposal(client, normalized.proposalId);
    const draft = await lockDraftRevision(client, proposal.subject_id);
    const policy = await lockPolicy(client, proposal.target_policy_id);
    const requirement = await lockRequirement(client, normalized.requirementId);
    const presentation = await lockApprovalPresentation(client, normalized.sourcePresentationId);
    if (
      proposal.status !== "pending_approval" ||
      Number(proposal.version) !== normalized.expectedProposalVersion ||
      Number(proposal.subject_revision) !== normalized.expectedSubjectRevision ||
      Number(proposal.subject_version) !== normalized.expectedSubjectVersion ||
      draft.status !== "pending_review" ||
      Number(draft.current_revision_number) !== normalized.expectedSubjectRevision ||
      Number(draft.version) !== normalized.expectedSubjectVersion ||
      !policy.enabled ||
      Number(policy.version) !== normalized.expectedTargetPolicyVersion ||
      Number(proposal.target_policy_version) !== normalized.expectedTargetPolicyVersion ||
      !policyMatchesDraft(policy, draft) ||
      requirement.proposal_id !== proposal.id ||
      requirement.state !== "pending" ||
      requirement.target_policy_id !== policy.id ||
      Number(requirement.target_policy_version) !== Number(policy.version) ||
      presentation.proposal_id !== proposal.id ||
      presentation.requirement_id !== requirement.id ||
      Number(presentation.proposal_version) !== normalized.expectedProposalVersion ||
      presentation.state !== "active" ||
      presentation.recipient_open_id !== normalized.actorOpenId
    ) throw new ActionProposalVersionConflictError();
    await validateDraftEvidence(client, draft);
    await requireApprovalAuthorization(client, requirement, normalized.actorOpenId);
    await requireCurrentReviewAttestation(client, normalized);
    return draft.source_group_id === null ? {} : { sourceGroupId: draft.source_group_id };
  });
}

async function getAuthorizedReviewContext(
  dataSource: PostgresKnowledgeDraftDataSource,
  input: { proposalId: string; actorOpenId: string },
): Promise<ActionReviewContext | undefined> {
  const normalized = {
    proposalId: requireReference("proposalId", input.proposalId),
    actorOpenId: requireReference("actorOpenId", input.actorOpenId),
  };
  return withTransaction(dataSource, (client) => loadAuthorizedReviewContext(client, normalized));
}

async function recordReviewAttestation(
  dataSource: PostgresKnowledgeDraftDataSource,
  input: RecordActionReviewAttestationInput,
): Promise<{ outcome: "applied" | "already_applied" }> {
  const normalized = normalizeReviewAttestationInput(input);
  const { at: _auditTimestamp, ...intent } = normalized;
  const fingerprint = operationFingerprint({ operation: "record_action_review_attestation", ...intent });
  return withTransaction(dataSource, async (client) => {
    await lockOperation(client, normalized.operationKey);
    const operation = await client.query<ActionReviewAttestationRow>(
      `${actionReviewAttestationSelect()} WHERE operation_key = $1`,
      [normalized.operationKey],
    );
    if (operation.rows[0] !== undefined) {
      if (operation.rows[0].operation_fingerprint !== fingerprint) {
        throw new ActionProposalOperationConflictError();
      }
      return { outcome: "already_applied" };
    }

    const context = await loadAuthorizedReviewContext(client, normalized);
    if (
      context === undefined ||
      context.proposalVersion !== normalized.expectedProposalVersion ||
      context.subjectRevision !== normalized.expectedSubjectRevision ||
      context.subjectVersion !== normalized.expectedSubjectVersion ||
      context.contentHash !== normalized.expectedContentHash
    ) throw new ActionProposalVersionConflictError();

    const existing = await client.query<ActionReviewAttestationRow>(
      `${actionReviewAttestationSelect()}
       WHERE proposal_id = $1 AND proposal_version = $2 AND actor_open_id = $3 AND content_hash = $4
       FOR UPDATE`,
      [
        normalized.proposalId,
        normalized.expectedProposalVersion,
        normalized.actorOpenId,
        normalized.expectedContentHash,
      ],
    );
    if (existing.rows[0] !== undefined) throw new ActionProposalOperationConflictError();

    await client.query(
      `INSERT INTO action_review_attestations (
        id, proposal_id, actor_open_id, subject_revision, subject_version, proposal_version,
        content_hash, session_id_hash, operation_key, operation_fingerprint, reviewed_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        randomUUID(),
        normalized.proposalId,
        normalized.actorOpenId,
        normalized.expectedSubjectRevision,
        normalized.expectedSubjectVersion,
        normalized.expectedProposalVersion,
        normalized.expectedContentHash,
        normalized.sessionIdHash,
        normalized.operationKey,
        fingerprint,
        normalized.at,
      ],
    );
    return { outcome: "applied" };
  });
}

async function hasCurrentReviewAttestation(
  dataSource: PostgresKnowledgeDraftDataSource,
  input: CurrentActionReviewAttestationInput,
): Promise<boolean> {
  const normalized = normalizeCurrentReviewAttestationInput(input);
  return withTransaction(dataSource, async (client) => {
    return hasCurrentReviewAttestationInTransaction(client, normalized);
  });
}

async function requireCurrentReviewAttestation(
  client: KnowledgeDraftTransactionClient,
  input: {
    action: "approve" | "request_revision" | "reject";
    requireReviewAttestation: boolean;
    proposalId: string;
    actorOpenId: string;
    expectedProposalVersion: number;
    expectedSubjectRevision: number;
    expectedSubjectVersion: number;
  },
): Promise<void> {
  if (input.action !== "approve" || !input.requireReviewAttestation) return;
  const context = await loadAuthorizedReviewContext(client, input);
  if (context === undefined || !await hasCurrentReviewAttestationInTransaction(client, {
    proposalId: input.proposalId,
    actorOpenId: input.actorOpenId,
    expectedProposalVersion: input.expectedProposalVersion,
    expectedSubjectRevision: input.expectedSubjectRevision,
    expectedSubjectVersion: input.expectedSubjectVersion,
    expectedContentHash: context.contentHash,
  })) throw new ActionProposalReviewRequiredError();
}

async function hasCurrentReviewAttestationInTransaction(
  client: KnowledgeDraftTransactionClient,
  input: CurrentActionReviewAttestationInput,
): Promise<boolean> {
  const context = await loadAuthorizedReviewContext(client, input);
  if (
    context === undefined ||
    context.proposalVersion !== input.expectedProposalVersion ||
    context.subjectRevision !== input.expectedSubjectRevision ||
    context.subjectVersion !== input.expectedSubjectVersion ||
    context.contentHash !== input.expectedContentHash
  ) return false;
  const result = await client.query<{ present: boolean }>(
    `SELECT EXISTS (
      SELECT 1 FROM action_review_attestations
      WHERE proposal_id = $1 AND proposal_version = $2 AND actor_open_id = $3
        AND subject_revision = $4 AND subject_version = $5 AND content_hash = $6
    ) AS present`,
    [
      input.proposalId,
      input.expectedProposalVersion,
      input.actorOpenId,
      input.expectedSubjectRevision,
      input.expectedSubjectVersion,
      input.expectedContentHash,
    ],
  );
  return result.rows[0]?.present === true;
}

async function loadAuthorizedReviewContext(
  client: KnowledgeDraftTransactionClient,
  input: { proposalId: string; actorOpenId: string },
): Promise<ActionReviewContext | undefined> {
  try {
    const proposal = await lockProposal(client, input.proposalId);
    if (proposal.status !== "pending_approval") return undefined;
    const draft = await lockDraftRevision(client, proposal.subject_id);
    if (
      draft.status !== "pending_review" ||
      Number(draft.current_revision_number) !== Number(proposal.subject_revision) ||
      Number(draft.version) !== Number(proposal.subject_version) ||
      draft.risk_level !== proposal.risk_level
    ) return undefined;
    const policy = await lockPolicy(client, proposal.target_policy_id);
    if (
      !policy.enabled ||
      Number(policy.version) !== Number(proposal.target_policy_version) ||
      !policyMatchesDraft(policy, draft)
    ) return undefined;
    const requirements = await client.query<RequirementRow>(
      `${requirementSelect()} WHERE proposal_id = $1 FOR UPDATE`,
      [proposal.id],
    );
    if (requirements.rows.some((requirement) =>
      requirement.target_policy_id !== policy.id ||
      Number(requirement.target_policy_version) !== Number(policy.version)
    )) return undefined;
    const hasAuthorizedPendingRequirement = await hasAuthorizedPendingReviewRequirement(
      client,
      requirements.rows,
      input.actorOpenId,
    );
    if (!hasAuthorizedPendingRequirement) return undefined;
    const evidence = await loadDraftEvidence(client, draft.id, Number(draft.current_revision_number));
    const invalidEvidence = await findInvalidKnowledgeDraftEvidence({
      queryable: client,
      sourceGroupId: draft.source_group_id ?? undefined,
      evidence,
    });
    if (invalidEvidence !== undefined) return undefined;
    return {
      proposalId: proposal.id,
      proposalVersion: Number(proposal.version),
      draftId: draft.id,
      subjectRevision: Number(draft.current_revision_number),
      subjectVersion: Number(draft.version),
      title: draft.title,
      content: draft.content,
      contentHash: createHash("sha256").update(draft.content).digest("hex"),
      riskLevel: draft.risk_level,
      targetDisplayName: policy.display_name,
      requirements: requirements.rows.map((requirement) => ({
        kind: requirement.requirement_kind,
        state: requirement.state,
      })),
    };
  } catch (error) {
    if (error instanceof ActionProposalIneligibleError || error instanceof ActionProposalAuthorizationError) {
      return undefined;
    }
    throw error;
  }
}

async function hasAuthorizedPendingReviewRequirement(
  client: KnowledgeDraftTransactionClient,
  requirements: RequirementRow[],
  actorOpenId: string,
): Promise<boolean> {
  for (const requirement of requirements) {
    if (requirement.state !== "pending") continue;
    try {
      await requireApprovalAuthorization(client, requirement, actorOpenId);
      return true;
    } catch (error) {
      if (!(error instanceof ActionProposalAuthorizationError)) throw error;
    }
  }
  return false;
}

async function getApprovalDeliveryContext(
  dataSource: PostgresKnowledgeDraftDataSource,
  id: string,
): Promise<ActionApprovalDeliveryContext | undefined> {
  const presentationResult = await dataSource.query<ApprovalPresentationRow>(
    `${approvalPresentationSelect()} WHERE id = $1`,
    [id],
  );
  const presentationRow = presentationResult.rows[0];
  if (presentationRow === undefined) return undefined;
  const context = await loadProposalContext(dataSource, presentationRow.proposal_id);
  if (context === undefined) return undefined;
  const draftResult = await dataSource.query<{ source_group_id: string | null }>(
    "SELECT source_group_id FROM knowledge_drafts WHERE id = $1",
    [context.proposal.subjectId],
  );
  const draft = draftResult.rows[0];
  if (draft === undefined) return undefined;
  const requirement = context.requirements.find((item) => item.id === presentationRow.requirement_id);
  if (requirement === undefined) return undefined;
  const policyResult = await dataSource.query<PolicyRow>(
    `${policySelect()} WHERE id = $1`,
    [context.proposal.targetPolicyId],
  );
  if (policyResult.rows[0] === undefined) return undefined;
  return {
    context,
    requirement,
    policy: mapPolicy(policyResult.rows[0]),
    presentation: mapApprovalPresentation(presentationRow),
    ...(draft.source_group_id === null ? {} : { sourceGroupId: draft.source_group_id }),
  };
}

async function beginApprovalExternalAttempt(
  dataSource: PostgresKnowledgeDraftDataSource,
  input: { presentationId: string; workerId: string; at: Date },
): Promise<void> {
  const normalized = normalizeApprovalDeliveryMutation(input);
  await withTransaction(dataSource, async (client) => {
    const identityResult = await client.query<{ proposal_id: string; requirement_id: string }>(
      "SELECT proposal_id, requirement_id FROM action_approval_presentations WHERE id = $1",
      [normalized.presentationId],
    );
    const identity = identityResult.rows[0];
    if (identity === undefined) throw new ActionProposalPersistenceConflictError();
    const proposal = await lockProposal(client, identity.proposal_id);
    const policy = await lockPolicy(client, proposal.target_policy_id);
    const requirement = await lockRequirement(client, identity.requirement_id);
    const presentation = await lockApprovalPresentation(client, normalized.presentationId);
    const outbox = await lockApprovalOutbox(client, normalized.presentationId);
    if (
      presentation.state !== "pending_send" ||
      outbox.state !== "processing" ||
      outbox.worker_id !== normalized.workerId ||
      presentation.proposal_id !== proposal.id ||
      presentation.requirement_id !== requirement.id ||
      proposal.status !== "pending_approval" ||
      Number(proposal.version) !== Number(presentation.proposal_version) ||
      requirement.proposal_id !== proposal.id ||
      requirement.state !== "pending" ||
      !policy.enabled ||
      policy.id !== proposal.target_policy_id ||
      Number(policy.version) !== Number(proposal.target_policy_version) ||
      requirement.target_policy_id !== policy.id ||
      Number(requirement.target_policy_version) !== Number(policy.version)
    ) {
      throw new ActionProposalPersistenceConflictError();
    }
    try {
      await requireApprovalAuthorization(client, requirement, presentation.recipient_open_id);
    } catch {
      throw new ActionProposalPersistenceConflictError();
    }
    await client.query(
      `UPDATE action_approval_presentation_outbox
       SET state = 'external_attempting', lease_until = NULL, updated_at = $3
       WHERE presentation_id = $1 AND worker_id = $2 AND state = 'processing'`,
      [normalized.presentationId, normalized.workerId, normalized.at],
    );
  });
}

async function failApprovalPresentationPreparation(
  dataSource: PostgresKnowledgeDraftDataSource,
  input: { presentationId: string; workerId: string; errorCode: string; at: Date },
): Promise<void> {
  const normalized = {
    ...normalizeApprovalDeliveryMutation(input),
    errorCode: requireReference("errorCode", input.errorCode),
  };
  await withTransaction(dataSource, async (client) => {
    const presentation = await lockApprovalPresentation(client, normalized.presentationId);
    const outbox = await lockApprovalOutbox(client, normalized.presentationId);
    if (outbox.state !== "processing" || outbox.worker_id !== normalized.workerId) {
      throw new ActionProposalPersistenceConflictError();
    }
    if (presentation.state === "pending_send") {
      await markApprovalPresentationSendFailed(client, presentation, normalized.errorCode, normalized.at);
    }
    await client.query(
      `UPDATE action_approval_presentation_outbox
       SET state = 'failed', worker_id = NULL, lease_until = NULL, retry_at = NULL,
           error_code = $3, updated_at = $4
       WHERE presentation_id = $1 AND worker_id = $2 AND state = 'processing'`,
      [normalized.presentationId, normalized.workerId, normalized.errorCode, normalized.at],
    );
  });
}

async function completeApprovalPresentationSend(
  dataSource: PostgresKnowledgeDraftDataSource,
  input: { presentationId: string; workerId: string; messageId: string; at: Date },
): Promise<void> {
  const normalized = {
    ...normalizeApprovalDeliveryMutation(input),
    messageId: requireReference("messageId", input.messageId),
  };
  await withTransaction(dataSource, async (client) => {
    const presentation = await lockApprovalPresentation(client, normalized.presentationId);
    const outbox = await lockApprovalOutbox(client, normalized.presentationId);
    if (
      outbox.state === "sent" &&
      presentation.state === "active" &&
      presentation.message_id === normalized.messageId
    ) return;
    if (
      presentation.state !== "pending_send" ||
      outbox.state !== "external_attempting" ||
      outbox.worker_id !== normalized.workerId
    ) throw new ActionProposalPersistenceConflictError();
    const fromVersion = Number(presentation.version);
    await client.query(
      `UPDATE action_approval_presentations
       SET state = 'active', message_id = $2, activated_at = $3, version = version + 1
       WHERE id = $1 AND state = 'pending_send' AND version = $4`,
      [normalized.presentationId, normalized.messageId, normalized.at, fromVersion],
    );
    await client.query(
      `INSERT INTO action_approval_presentation_events (
        id, presentation_id, event_type, operation_key, from_version, to_version, created_at
      ) VALUES ($1, $2, 'send_succeeded', $3, $4, $5, $6)`,
      [
        randomUUID(),
        normalized.presentationId,
        derivedOperationKey("action-presentation-send-succeeded", {
          presentationId: normalized.presentationId,
          messageId: normalized.messageId,
          fromVersion,
        }),
        fromVersion,
        fromVersion + 1,
        normalized.at,
      ],
    );
    await client.query(
      `UPDATE action_approval_presentation_outbox
       SET state = 'sent', worker_id = NULL, lease_until = NULL, retry_at = NULL,
           error_code = NULL, updated_at = $3
       WHERE presentation_id = $1 AND worker_id = $2 AND state = 'external_attempting'`,
      [normalized.presentationId, normalized.workerId, normalized.at],
    );
  });
}

async function failApprovalPresentationSend(
  dataSource: PostgresKnowledgeDraftDataSource,
  input: {
    presentationId: string;
    workerId: string;
    classification: "retryable" | "permanent" | "outcome_unknown";
    errorCode: string;
    retryAt?: Date;
    at: Date;
  },
): Promise<void> {
  const classification = input.classification;
  if (!(classification === "retryable" || classification === "permanent" || classification === "outcome_unknown")) {
    throw new Error("classification is invalid");
  }
  const normalized = {
    ...normalizeApprovalDeliveryMutation(input),
    classification,
    errorCode: requireReference("errorCode", input.errorCode),
    ...(input.retryAt === undefined ? {} : { retryAt: requireDate(input.retryAt) }),
  };
  if (
    (classification === "retryable") !== (normalized.retryAt !== undefined) ||
    (normalized.retryAt !== undefined && normalized.retryAt.getTime() <= normalized.at.getTime())
  ) throw new Error("retryAt is invalid");
  await withTransaction(dataSource, async (client) => {
    const presentation = await lockApprovalPresentation(client, normalized.presentationId);
    const outbox = await lockApprovalOutbox(client, normalized.presentationId);
    if (outbox.state !== "external_attempting" || outbox.worker_id !== normalized.workerId) {
      throw new ActionProposalPersistenceConflictError();
    }
    if (classification === "permanent" && presentation.state === "pending_send") {
      await markApprovalPresentationSendFailed(client, presentation, normalized.errorCode, normalized.at);
    }
    const state = classification === "retryable"
      ? "pending"
      : classification === "permanent" ? "failed" : "outcome_unknown";
    await client.query(
      `UPDATE action_approval_presentation_outbox
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

async function markApprovalPresentationSendFailed(
  client: KnowledgeDraftTransactionClient,
  presentation: ApprovalPresentationRow,
  errorCode: string,
  at: Date,
): Promise<void> {
  const fromVersion = Number(presentation.version);
  await client.query(
    `UPDATE action_approval_presentations
     SET state = 'send_failed', version = version + 1
     WHERE id = $1 AND state = 'pending_send' AND version = $2`,
    [presentation.id, fromVersion],
  );
  await client.query(
    `INSERT INTO action_approval_presentation_events (
      id, presentation_id, event_type, operation_key, from_version, to_version, created_at
    ) VALUES ($1, $2, 'send_failed', $3, $4, $5, $6)`,
    [
      randomUUID(),
      presentation.id,
      derivedOperationKey("action-presentation-send-failed", {
        presentationId: presentation.id,
        errorCode,
        fromVersion,
      }),
      fromVersion,
      fromVersion + 1,
      at,
    ],
  );
}

async function lockApprovalOutbox(
  client: KnowledgeDraftTransactionClient,
  presentationId: string,
): Promise<ApprovalOutboxRow> {
  const result = await client.query<ApprovalOutboxRow>(
    `${approvalOutboxSelect()} WHERE presentation_id = $1 FOR UPDATE`,
    [presentationId],
  );
  if (result.rows[0] === undefined) throw new ActionProposalPersistenceConflictError();
  return result.rows[0];
}

function normalizeApprovalDeliveryMutation(input: {
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

async function cancelStaleProposals(
  dataSource: PostgresKnowledgeDraftDataSource,
  input: CancelStaleActionProposalsInput,
): Promise<CancelStaleActionProposalsResult> {
  const normalized = normalizeCancelStaleInput(input);
  const fingerprint = operationFingerprint({ operation: "cancel_stale_action_proposals", ...normalized });
  const reasonCode = `stale-draft:${operationFingerprint(normalized.operationKey)}`;
  return withTransaction(dataSource, async (client) => {
    await lockOperation(client, normalized.operationKey);
    const replay = await client.query<{
      draft_id: string;
      operation_fingerprint: string;
      to_version: string | number;
    }>(
      `SELECT draft_id, operation_fingerprint, to_version
       FROM knowledge_draft_events WHERE operation_key = $1`,
      [normalized.operationKey],
    );
    if (replay.rows[0] !== undefined) {
      if (
        replay.rows[0].draft_id !== normalized.draftId ||
        replay.rows[0].operation_fingerprint !== fingerprint
      ) throw new ActionProposalOperationConflictError();
      return {
        outcome: "already_applied",
        cancelledProposalIds: await listInvalidatedProposalIds(
          client,
          normalized.draftId,
          reasonCode,
        ),
        draftVersion: Number(replay.rows[0].to_version),
      };
    }

    const draft = await lockDraftRevision(client, normalized.draftId);
    if (
      Number(draft.current_revision_number) !== normalized.currentRevision ||
      Number(draft.version) !== normalized.currentDraftVersion
    ) throw new ActionProposalVersionConflictError();

    const stale = await client.query<ProposalRow>(
      `${proposalSelect()} WHERE subject_id = $1
        AND status IN ('pending_approval', 'approved', 'executing', 'reconciliation_required')
        AND (subject_revision <> $2 OR subject_version <> $3)
       ORDER BY id ASC FOR UPDATE`,
      [normalized.draftId, normalized.currentRevision, normalized.currentDraftVersion],
    );
    if (stale.rows.length === 0) {
      return {
        outcome: "applied",
        cancelledProposalIds: [],
        draftVersion: normalized.currentDraftVersion,
      };
    }

    for (const proposal of stale.rows) {
      const fromVersion = Number(proposal.version);
      await client.query(
        `UPDATE action_proposals SET status = 'cancelled', version = version + 1, updated_at = $2
         WHERE id = $1 AND version = $3`,
        [proposal.id, normalized.at, fromVersion],
      );
      await client.query(
        `UPDATE action_approval_requirements
         SET state = 'invalidated', satisfied_actor_open_id = NULL,
             satisfied_source_type = NULL, satisfied_source_id = NULL,
             version = version + 1, updated_at = $2
         WHERE proposal_id = $1 AND state <> 'invalidated'`,
        [proposal.id, normalized.at],
      );
      const superseded = await client.query<{ id: string; version: string | number }>(
        `UPDATE action_approval_presentations
         SET state = 'superseded', version = version + 1
         WHERE proposal_id = $1 AND state IN ('pending_send', 'active', 'send_failed')
         RETURNING id, version`,
        [proposal.id],
      );
      for (const presentation of superseded.rows) {
        const toVersion = Number(presentation.version);
        await client.query(
          `INSERT INTO action_approval_presentation_events (
            id, presentation_id, event_type, operation_key, from_version, to_version, created_at
          ) VALUES ($1, $2, 'superseded', $3, $4, $5, $6)`,
          [
            randomUUID(),
            presentation.id,
            derivedOperationKey("action-presentation-superseded", {
              operationKey: normalized.operationKey,
              presentationId: presentation.id,
            }),
            toVersion - 1,
            toVersion,
            normalized.at,
          ],
        );
      }
      await client.query(
        `UPDATE action_approval_presentation_outbox
         SET state = 'failed', worker_id = NULL, lease_until = NULL, retry_at = NULL,
             error_code = 'presentation_superseded', updated_at = $2
         WHERE presentation_id IN (
           SELECT id FROM action_approval_presentations WHERE proposal_id = $1
         ) AND state IN ('pending', 'processing')`,
        [proposal.id, normalized.at],
      );
      await client.query(
        `INSERT INTO action_events (
          id, proposal_id, event_type, operation_key, from_version, to_version,
          reason_code, created_at
        ) VALUES ($1, $2, 'approval_invalidated', $3, $4, $5, $6, $7)`,
        [
          randomUUID(),
          proposal.id,
          derivedOperationKey("action-proposal-invalidated", {
            operationKey: normalized.operationKey,
            proposalId: proposal.id,
          }),
          fromVersion,
          fromVersion + 1,
          reasonCode,
          normalized.at,
        ],
      );
    }

    const nextDraftVersion = normalized.currentDraftVersion + 1;
    await client.query(
      `UPDATE knowledge_drafts SET version = version + 1, updated_at = $2
       WHERE id = $1 AND version = $3`,
      [normalized.draftId, normalized.at, normalized.currentDraftVersion],
    );
    await client.query(
      `INSERT INTO knowledge_draft_events (
        id, draft_id, event_type, from_version, to_version, operation_key,
        operation_fingerprint, actor, reason, revision_number, created_at
      ) VALUES ($1, $2, 'approval_invalidated', $3, $4, $5, $6,
        'iris-action-planner', 'stale_action_proposal', $7, $8)`,
      [
        randomUUID(),
        normalized.draftId,
        normalized.currentDraftVersion,
        nextDraftVersion,
        normalized.operationKey,
        fingerprint,
        normalized.currentRevision,
        normalized.at,
      ],
    );
    return {
      outcome: "applied",
      cancelledProposalIds: stale.rows.map((proposal) => proposal.id),
      draftVersion: nextDraftVersion,
    };
  });
}

async function listInvalidatedProposalIds(
  client: KnowledgeDraftTransactionClient,
  draftId: string,
  reasonCode: string,
): Promise<string[]> {
  const result = await client.query<{ id: string }>(
    `SELECT proposal.id
     FROM action_proposals proposal
     JOIN action_events event ON event.proposal_id = proposal.id
     WHERE proposal.subject_id = $1 AND event.event_type = 'approval_invalidated'
       AND event.reason_code = $2
     ORDER BY proposal.id ASC`,
    [draftId, reasonCode],
  );
  return result.rows.map((row) => row.id);
}

async function applyApprovalAction(
  dataSource: PostgresKnowledgeDraftDataSource,
  input: ApplyActionProposalActionInput,
): Promise<ApplyActionProposalActionResult> {
  const normalized = normalizeApplyActionInput(input);
  const fingerprint = actionApprovalFingerprint(normalized);
  return withTransaction(dataSource, async (client) => {
    await lockOperation(client, normalized.operationKey);
    const replay = await inspectNormalizedApprovalActionReplay(client, normalized, fingerprint);
    if (replay !== undefined) return replay.result;

    const proposal = await lockProposal(client, normalized.proposalId);
    if (
      proposal.status !== "pending_approval" ||
      Number(proposal.version) !== normalized.expectedProposalVersion ||
      Number(proposal.subject_revision) !== normalized.expectedSubjectRevision ||
      Number(proposal.subject_version) !== normalized.expectedSubjectVersion ||
      Number(proposal.target_policy_version) !== normalized.expectedTargetPolicyVersion
    ) throw new ActionProposalVersionConflictError();
    const draft = await lockDraftRevision(client, proposal.subject_id);
    if (
      draft.status !== "pending_review" ||
      Number(draft.current_revision_number) !== normalized.expectedSubjectRevision ||
      Number(draft.version) !== normalized.expectedSubjectVersion
    ) throw new ActionProposalVersionConflictError();
    await validateDraftEvidence(client, draft);
    const policy = await lockPolicy(client, proposal.target_policy_id);
    if (
      !policy.enabled ||
      Number(policy.version) !== Number(proposal.target_policy_version) ||
      !policyMatchesDraft(policy, draft)
    ) throw new ActionProposalIneligibleError();

    const requirement = await lockRequirement(client, normalized.requirementId);
    if (
      requirement.proposal_id !== proposal.id ||
      requirement.state !== "pending" ||
      requirement.target_policy_id !== policy.id ||
      Number(requirement.target_policy_version) !== Number(policy.version)
    ) throw new ActionProposalIneligibleError();
    const presentation = await lockApprovalPresentation(client, normalized.sourcePresentationId);
    if (
      presentation.proposal_id !== proposal.id ||
      presentation.requirement_id !== requirement.id ||
      Number(presentation.proposal_version) !== normalized.expectedProposalVersion ||
      presentation.state !== "active" ||
      presentation.recipient_open_id !== normalized.actorOpenId
    ) throw new ActionProposalAuthorizationError();
    const authorizationSummary = await requireApprovalAuthorization(
      client,
      requirement,
      normalized.actorOpenId,
    );

    if (normalized.action !== "approve") {
      return applyProposalDisposition(
        client,
        proposal,
        requirement,
        presentation,
        normalized,
        fingerprint,
      );
    }

    await requireCurrentReviewAttestation(client, normalized);

    const approvalId = randomUUID();
    await client.query(
      `INSERT INTO action_approvals (
        id, proposal_id, requirement_id, actor_open_id, source_presentation_id,
        callback_event_id, subject_revision, subject_version, authorization_summary,
        operation_key, operation_fingerprint, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        approvalId,
        proposal.id,
        requirement.id,
        normalized.actorOpenId,
        presentation.id,
        normalized.callbackEventId,
        normalized.expectedSubjectRevision,
        normalized.expectedSubjectVersion,
        authorizationSummary,
        normalized.operationKey,
        fingerprint,
        normalized.at,
      ],
    );
    await client.query(
      `UPDATE action_approval_requirements
       SET state = 'satisfied', satisfied_actor_open_id = $2,
           satisfied_source_type = 'action_approval', satisfied_source_id = $3,
           version = version + 1, updated_at = $4
       WHERE id = $1 AND state = 'pending'`,
      [requirement.id, normalized.actorOpenId, approvalId, normalized.at],
    );

    const approvalRecordedVersion = normalized.expectedProposalVersion + 1;
    await client.query(
      `UPDATE action_proposals SET version = version + 1, updated_at = $2
       WHERE id = $1 AND version = $3`,
      [proposal.id, normalized.at, normalized.expectedProposalVersion],
    );
    await client.query(
      `INSERT INTO action_events (
        id, proposal_id, event_type, actor_open_id, operation_key,
        from_version, to_version, created_at
      ) VALUES ($1, $2, 'approval_recorded', $3, $4, $5, $6, $7)`,
      [
        randomUUID(),
        proposal.id,
        normalized.actorOpenId,
        derivedOperationKey("action-approval-recorded", normalized.operationKey),
        normalized.expectedProposalVersion,
        approvalRecordedVersion,
        normalized.at,
      ],
    );

    const pending = await client.query<{ present: boolean }>(
      `SELECT EXISTS (
        SELECT 1 FROM action_approval_requirements
        WHERE proposal_id = $1 AND state <> 'satisfied'
      ) AS present`,
      [proposal.id],
    );
    let finalProposalVersion = approvalRecordedVersion;
    let finalDraftVersion = normalized.expectedSubjectVersion;
    if (pending.rows[0]?.present !== false) throw new ActionProposalPersistenceConflictError();

    finalDraftVersion += 1;
    await client.query(
      `UPDATE knowledge_drafts SET version = version + 1, updated_at = $2
       WHERE id = $1 AND version = $3 AND status = 'pending_review'`,
      [proposal.subject_id, normalized.at, normalized.expectedSubjectVersion],
    );
    const draftEventOperationKey = derivedOperationKey(
      "knowledge-draft-review-approved",
      normalized.operationKey,
    );
    await client.query(
      `INSERT INTO knowledge_draft_events (
        id, draft_id, event_type, from_version, to_version, operation_key,
        operation_fingerprint, actor, revision_number, created_at
      ) VALUES ($1, $2, 'review_approved', $3, $4, $5, $6, $7, $8, $9)`,
      [
        randomUUID(),
        proposal.subject_id,
        normalized.expectedSubjectVersion,
        finalDraftVersion,
        draftEventOperationKey,
        operationFingerprint({
          operation: "knowledge_draft_review_approved",
          proposalId: proposal.id,
          approvalOperationKey: normalized.operationKey,
        }),
        normalized.actorOpenId,
        normalized.expectedSubjectRevision,
        normalized.at,
      ],
    );
    finalProposalVersion += 1;
    await client.query(
      `UPDATE action_proposals
       SET status = 'approved', subject_version = $2, version = version + 1, updated_at = $3
       WHERE id = $1 AND version = $4`,
      [proposal.id, finalDraftVersion, normalized.at, approvalRecordedVersion],
    );
    await client.query(
      `INSERT INTO action_events (
        id, proposal_id, event_type, actor_open_id, operation_key,
        from_version, to_version, reason_code, created_at
      ) VALUES ($1, $2, 'requirements_satisfied', $3, $4, $5, $6,
        'all_current_requirements_satisfied', $7)`,
      [
        randomUUID(),
        proposal.id,
        normalized.actorOpenId,
        derivedOperationKey("action-requirements-satisfied", normalized.operationKey),
        approvalRecordedVersion,
        finalProposalVersion,
        normalized.at,
      ],
    );
    await closeActionPresentation(client, presentation, normalized, "approved");

    return {
      outcome: "applied",
      action: normalized.action,
      proposal: await requireProposal(client, proposal.id),
      draftStatus: "pending_review",
      draftVersion: finalDraftVersion,
    };
  });
}

async function inspectApprovalActionReplay(
  dataSource: PostgresKnowledgeDraftDataSource,
  input: ApplyActionProposalActionInput,
): Promise<ActionApprovalReplayInspection | undefined> {
  const normalized = normalizeApplyActionInput(input);
  const fingerprint = actionApprovalFingerprint(normalized);
  return inspectNormalizedApprovalActionReplay(dataSource, normalized, fingerprint);
}

async function claimApprovedPublicationExecution(
  dataSource: PostgresKnowledgeDraftDataSource,
  input: ClaimApprovedPublicationExecutionInput,
): Promise<ClaimApprovedPublicationExecutionResult> {
  const normalized = normalizeClaimPublicationExecutionInput(input);
  return withTransaction(dataSource, async (client) => {
    await lockOperation(client, normalized.operationKey);
    const replay = await client.query<PublicationExecutionRow>(
      `${publicationExecutionSelect()} execution
       JOIN action_execution_events event ON event.execution_id = execution.id
       WHERE event.operation_key = $1`,
      [normalized.operationKey],
    );
    if (replay.rows[0] !== undefined) {
      return buildPublicationExecutionClaimResult(client, replay.rows[0]);
    }

    const proposal = await lockProposal(client, normalized.proposalId);
    if (
      proposal.status !== "approved" ||
      Number(proposal.version) !== normalized.expectedProposalVersion
    ) throw new ActionProposalVersionConflictError();
    const draft = await lockDraftRevision(client, proposal.subject_id);
    if (
      draft.status !== "pending_review" ||
      Number(draft.current_revision_number) !== Number(proposal.subject_revision) ||
      Number(draft.version) !== Number(proposal.subject_version)
    ) throw new ActionProposalVersionConflictError();
    if (
      !normalized.runtimeGate.globalEnabled ||
      !normalized.runtimeGate.writeKnowledgeBase ||
      (draft.source_group_id !== null && normalized.runtimeGate.disabledGroupIds.includes(draft.source_group_id))
    ) throw new ActionProposalIneligibleError();
    await validateDraftEvidence(client, draft);
    const policy = await lockPolicy(client, proposal.target_policy_id);
    if (
      !policy.enabled ||
      Number(policy.version) !== Number(proposal.target_policy_version) ||
      !policyMatchesDraft(policy, draft)
    ) throw new ActionProposalIneligibleError();
    await requireNoPublicationForDraftRevision(
      client,
      proposal.subject_id,
      Number(proposal.subject_revision),
    );
    await requireAllRequirementsSatisfied(client, proposal.id);
    const existingLiveExecution = await client.query<{ id: string }>(
      `SELECT id FROM action_executions
       WHERE proposal_id = $1 AND state IN ('executing', 'succeeded', 'outcome_unknown', 'reconciliation_required')
       FOR UPDATE`,
      [proposal.id],
    );
    if (existingLiveExecution.rows[0] !== undefined) throw new ActionProposalIneligibleError();

    const executionId = randomUUID();
    const requestFingerprint = operationFingerprint({
      operation: "feishu_wiki_publish_request",
      proposalId: proposal.id,
      draftId: proposal.subject_id,
      revisionNumber: Number(proposal.subject_revision),
      draftVersion: Number(proposal.subject_version),
      targetPolicyId: policy.id,
      targetPolicyVersion: Number(policy.version),
    });
    await client.query(
      `INSERT INTO action_executions (
        id, proposal_id, attempt_number, state, request_fingerprint, provider,
        version, created_at, updated_at
      ) VALUES ($1, $2, 1, 'executing', $3, 'feishu_wiki', 1, $4, $4)`,
      [executionId, proposal.id, requestFingerprint, normalized.at],
    );
    await client.query(
      `INSERT INTO action_execution_events (
        id, execution_id, event_type, operation_key, from_version, to_version, created_at
      ) VALUES ($1, $2, 'started', $3, NULL, 1, $4)`,
      [randomUUID(), executionId, normalized.operationKey, normalized.at],
    );
    const nextProposalVersion = normalized.expectedProposalVersion + 1;
    await client.query(
      `UPDATE action_proposals
       SET status = 'executing', version = version + 1, updated_at = $2
       WHERE id = $1 AND version = $3 AND status = 'approved'`,
      [proposal.id, normalized.at, normalized.expectedProposalVersion],
    );
    await client.query(
      `INSERT INTO action_events (
        id, proposal_id, event_type, operation_key,
        from_version, to_version, reason_code, created_at
      ) VALUES ($1, $2, 'execution_started', $3, $4, $5,
        'publication_execution_claimed', $6)`,
      [
        randomUUID(),
        proposal.id,
        derivedOperationKey("action-execution-started", normalized.operationKey),
        normalized.expectedProposalVersion,
        nextProposalVersion,
        normalized.at,
      ],
    );

    const execution = await requirePublicationExecution(client, executionId);
    return {
      outcome: "applied",
      proposal: await requireProposal(client, proposal.id),
      execution,
      draft: mapClaimedPublicationDraft(draft),
      policy: mapPolicy(policy),
    };
  });
}

async function completePublicationExecution(
  dataSource: PostgresKnowledgeDraftDataSource,
  input: CompletePublicationExecutionInput,
): Promise<CompletePublicationExecutionResult> {
  const normalized = normalizeCompletePublicationExecutionInput(input);
  const fingerprint = operationFingerprint({
    operation: "complete_publication_execution",
    ...normalized,
  });
  return withTransaction(dataSource, async (client) => {
    await lockOperation(client, normalized.operationKey);
    const replay = await client.query<KnowledgePublicationRow>(
      `${knowledgePublicationSelect()} WHERE operation_key = $1`,
      [normalized.operationKey],
    );
    if (replay.rows[0] !== undefined) {
      const publication = mapKnowledgePublication(replay.rows[0]);
      if (
        publication.proposalId !== normalized.proposalId ||
        publication.executionId !== normalized.executionId
      ) throw new ActionProposalOperationConflictError();
      return {
        outcome: "already_applied",
        proposal: await requireProposal(client, normalized.proposalId),
        execution: await requirePublicationExecution(client, normalized.executionId),
        ...(await publicationDraftResult(client, publication.draftId)),
        publication,
      };
    }

    const proposal = await lockProposal(client, normalized.proposalId);
    if (
      proposal.status !== "executing" ||
      Number(proposal.version) !== normalized.expectedProposalVersion ||
      Number(proposal.subject_revision) !== normalized.expectedSubjectRevision
    ) throw new ActionProposalVersionConflictError();
    const execution = await lockPublicationExecution(client, normalized.executionId);
    if (
      execution.proposal_id !== proposal.id ||
      execution.state !== "executing" ||
      Number(execution.version) !== normalized.expectedExecutionVersion
    ) throw new ActionProposalVersionConflictError();
    const draft = await lockDraftRevision(client, proposal.subject_id);
    if (
      draft.status !== "pending_review" ||
      Number(draft.current_revision_number) !== normalized.expectedSubjectRevision ||
      Number(draft.version) !== normalized.expectedDraftVersion ||
      Number(draft.version) !== Number(proposal.subject_version)
    ) throw new ActionProposalVersionConflictError();
    await validateDraftEvidence(client, draft);
    const policy = await lockPolicy(client, proposal.target_policy_id);
    if (
      !policy.enabled ||
      Number(policy.version) !== Number(proposal.target_policy_version) ||
      !policyMatchesDraft(policy, draft)
    ) throw new ActionProposalIneligibleError();
    await requireNoPublicationForDraftRevision(
      client,
      proposal.subject_id,
      Number(proposal.subject_revision),
    );

    const publicationId = randomUUID();
    await client.query(
      `INSERT INTO knowledge_publications (
        id, proposal_id, execution_id, draft_id, revision_number, draft_version,
        target_policy_id, target_policy_version, space_id, remote_node_token,
        remote_document_token, remote_document_type, remote_document_version,
        content_hash, permission_check_summary, operation_key, operation_fingerprint,
        published_at, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
        $11, $12, $13, $14, $15, $16, $17, $18, $18)`,
      [
        publicationId,
        proposal.id,
        execution.id,
        proposal.subject_id,
        Number(proposal.subject_revision),
        normalized.expectedDraftVersion,
        policy.id,
        Number(policy.version),
        policy.space_id,
        normalized.remoteNodeToken,
        normalized.remoteDocumentToken,
        normalized.remoteDocumentType,
        normalized.remoteDocumentVersion ?? null,
        normalized.contentHash,
        normalized.permissionCheckSummary,
        normalized.operationKey,
        fingerprint,
        normalized.at,
      ],
    );
    const nextExecutionVersion = normalized.expectedExecutionVersion + 1;
    await client.query(
      `UPDATE action_executions
       SET state = 'succeeded', response_classification = 'success',
           remote_node_token = $2, remote_document_token = $3,
           version = version + 1, updated_at = $4
       WHERE id = $1 AND version = $5 AND state = 'executing'`,
      [
        execution.id,
        normalized.remoteNodeToken,
        normalized.remoteDocumentToken,
        normalized.at,
        normalized.expectedExecutionVersion,
      ],
    );
    await client.query(
      `INSERT INTO action_execution_events (
        id, execution_id, event_type, operation_key, from_version, to_version,
        response_classification, created_at
      ) VALUES ($1, $2, 'succeeded', $3, $4, $5, 'success', $6)`,
      [
        randomUUID(),
        execution.id,
        derivedOperationKey("action-execution-succeeded", normalized.operationKey),
        normalized.expectedExecutionVersion,
        nextExecutionVersion,
        normalized.at,
      ],
    );
    const nextDraftVersion = normalized.expectedDraftVersion + 1;
    await client.query(
      `UPDATE knowledge_drafts
       SET status = 'published', version = version + 1, published_at = $2,
           published_by = 'iris_publication_executor', updated_at = $2
       WHERE id = $1 AND version = $3 AND status = 'pending_review'`,
      [proposal.subject_id, normalized.at, normalized.expectedDraftVersion],
    );
    await client.query(
      `INSERT INTO knowledge_draft_events (
        id, draft_id, event_type, from_version, to_version, operation_key,
        operation_fingerprint, actor, revision_number, created_at
      ) VALUES ($1, $2, 'publication_succeeded', $3, $4, $5, $6,
        'iris_publication_executor', $7, $8)`,
      [
        randomUUID(),
        proposal.subject_id,
        normalized.expectedDraftVersion,
        nextDraftVersion,
        derivedOperationKey("knowledge-draft-publication-succeeded", normalized.operationKey),
        operationFingerprint({
          operation: "knowledge_draft_publication_succeeded",
          proposalId: proposal.id,
          executionId: execution.id,
          publicationOperationKey: normalized.operationKey,
        }),
        normalized.expectedSubjectRevision,
        normalized.at,
      ],
    );
    const nextProposalVersion = normalized.expectedProposalVersion + 1;
    await client.query(
      `UPDATE action_proposals
       SET status = 'succeeded', version = version + 1, updated_at = $2
       WHERE id = $1 AND version = $3 AND status = 'executing'`,
      [proposal.id, normalized.at, normalized.expectedProposalVersion],
    );
    await client.query(
      `INSERT INTO action_events (
        id, proposal_id, event_type, operation_key,
        from_version, to_version, reason_code, created_at
      ) VALUES ($1, $2, 'execution_succeeded', $3, $4, $5,
        'publication_created', $6)`,
      [
        randomUUID(),
        proposal.id,
        derivedOperationKey("action-execution-succeeded", normalized.operationKey),
        normalized.expectedProposalVersion,
        nextProposalVersion,
        normalized.at,
      ],
    );

    const publication = await requireKnowledgePublication(client, publicationId);
    return {
      outcome: "applied",
      proposal: await requireProposal(client, proposal.id),
      execution: await requirePublicationExecution(client, execution.id),
      draftStatus: "published",
      draftVersion: nextDraftVersion,
      publication,
    };
  });
}

async function applyGovernanceDisposition(
  dataSource: PostgresKnowledgeDraftDataSource,
  input: ApplyActionProposalGovernanceDispositionInput,
): Promise<ApplyActionProposalGovernanceDispositionResult> {
  const normalized = normalizeGovernanceDispositionInput(input);
  const { at: _auditTimestamp, ...intent } = normalized;
  const fingerprint = operationFingerprint({
    operation: "apply_action_proposal_governance_disposition",
    ...intent,
  });
  return withTransaction(dataSource, async (client) => {
    await lockOperation(client, normalized.operationKey);
    const eventType = normalized.action === "request_revision" ? "revision_requested" : "rejected";
    const replay = await client.query<{
      draft_id: string;
      event_type: string;
      operation_fingerprint: string;
      to_version: string | number;
    }>(
      `SELECT draft_id, event_type, operation_fingerprint, to_version
       FROM knowledge_draft_events WHERE operation_key = $1`,
      [normalized.operationKey],
    );
    if (replay.rows[0] !== undefined) {
      const proposal = await requireProposal(client, normalized.proposalId);
      if (
        replay.rows[0].draft_id !== proposal.subjectId ||
        replay.rows[0].event_type !== eventType ||
        replay.rows[0].operation_fingerprint !== fingerprint
      ) throw new ActionProposalOperationConflictError();
      const draft = await requireDraftState(client, proposal.subjectId);
      return {
        outcome: "already_applied",
        action: normalized.action,
        proposal,
        draftStatus: draft.status,
        draftVersion: Number(replay.rows[0].to_version),
      };
    }

    const proposal = await lockProposal(client, normalized.proposalId);
    if (
      proposal.status !== "pending_approval" ||
      Number(proposal.version) !== normalized.expectedProposalVersion ||
      Number(proposal.subject_revision) !== normalized.expectedSubjectRevision ||
      Number(proposal.subject_version) !== normalized.expectedSubjectVersion
    ) throw new ActionProposalVersionConflictError();
    const draft = await lockDraftRevision(client, proposal.subject_id);
    if (
      draft.status !== "pending_review" ||
      Number(draft.current_revision_number) !== normalized.expectedSubjectRevision ||
      Number(draft.version) !== normalized.expectedSubjectVersion
    ) throw new ActionProposalVersionConflictError();

    const presentations = await client.query<ApprovalPresentationRow>(
      `${approvalPresentationSelect()} WHERE proposal_id = $1
       AND state IN ('pending_send', 'active') FOR UPDATE`,
      [proposal.id],
    );
    if (presentations.rows.length > 0) {
      const externalAttempt = await client.query<{ present: boolean }>(
        `SELECT EXISTS (
          SELECT 1 FROM action_approval_presentation_outbox
          WHERE presentation_id = ANY($1::TEXT[]) AND state = 'external_attempting'
          FOR UPDATE
        ) AS present`,
        [presentations.rows.map((item) => item.id)],
      );
      if (externalAttempt.rows[0]?.present === true) {
        throw new ActionProposalPersistenceConflictError();
      }
    }

    const draftStatus: KnowledgeDraftStatus = normalized.action === "request_revision"
      ? "needs_revision"
      : "rejected";
    const nextDraftVersion = normalized.expectedSubjectVersion + 1;
    if (normalized.action === "request_revision") {
      await client.query(
        `UPDATE knowledge_drafts
         SET status = 'needs_revision', version = version + 1, updated_at = $2
         WHERE id = $1 AND version = $3 AND status = 'pending_review'`,
        [proposal.subject_id, normalized.at, normalized.expectedSubjectVersion],
      );
    } else {
      await client.query(
        `UPDATE knowledge_drafts
         SET status = 'rejected', version = version + 1, rejected_at = $2,
             rejected_by = $3, rejection_reason = $4, updated_at = $2
         WHERE id = $1 AND version = $5 AND status = 'pending_review'`,
        [
          proposal.subject_id,
          normalized.at,
          normalized.operator,
          normalized.reason,
          normalized.expectedSubjectVersion,
        ],
      );
    }
    await client.query(
      `INSERT INTO knowledge_draft_events (
        id, draft_id, event_type, from_version, to_version, operation_key,
        operation_fingerprint, actor, reason, revision_number, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        randomUUID(),
        proposal.subject_id,
        eventType,
        normalized.expectedSubjectVersion,
        nextDraftVersion,
        normalized.operationKey,
        fingerprint,
        normalized.operator,
        normalized.reason,
        normalized.expectedSubjectRevision,
        normalized.at,
      ],
    );
    await client.query(
      `UPDATE action_approval_requirements
       SET state = 'invalidated', satisfied_actor_open_id = NULL,
           satisfied_source_type = NULL, satisfied_source_id = NULL,
           version = version + 1, updated_at = $2
       WHERE proposal_id = $1 AND state <> 'invalidated'`,
      [proposal.id, normalized.at],
    );
    const nextProposalVersion = normalized.expectedProposalVersion + 1;
    await client.query(
      `UPDATE action_proposals
       SET status = 'cancelled', version = version + 1, updated_at = $2
       WHERE id = $1 AND version = $3 AND status = 'pending_approval'`,
      [proposal.id, normalized.at, normalized.expectedProposalVersion],
    );
    await client.query(
      `INSERT INTO action_events (
        id, proposal_id, event_type, actor_open_id, operation_key,
        from_version, to_version, reason_code, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        randomUUID(),
        proposal.id,
        eventType,
        normalized.operator,
        derivedOperationKey(`governance-${eventType}`, normalized.operationKey),
        normalized.expectedProposalVersion,
        nextProposalVersion,
        normalized.action === "request_revision"
          ? "operator_requested_revision"
          : "operator_rejected",
        normalized.at,
      ],
    );
    for (const presentation of presentations.rows) {
      const fromVersion = Number(presentation.version);
      await client.query(
        `UPDATE action_approval_presentations
         SET state = 'closed', version = version + 1, closed_at = $2
         WHERE id = $1 AND version = $3 AND state IN ('pending_send', 'active')`,
        [presentation.id, normalized.at, fromVersion],
      );
      await client.query(
        `INSERT INTO action_approval_presentation_events (
          id, presentation_id, event_type, actor_open_id, operation_key,
          callback_event_id, from_version, to_version, created_at
        ) VALUES ($1, $2, $3, $4, $5, NULL, $6, $7, $8)`,
        [
          randomUUID(),
          presentation.id,
          eventType,
          normalized.operator,
          derivedOperationKey(`governance-presentation-${eventType}`, `${normalized.operationKey}:${presentation.id}`),
          fromVersion,
          fromVersion + 1,
          normalized.at,
        ],
      );
      await client.query(
        `UPDATE action_approval_presentation_outbox
         SET state = 'failed', worker_id = NULL, lease_until = NULL, retry_at = NULL,
             error_code = 'governance_disposition', updated_at = $2
         WHERE presentation_id = $1 AND state IN ('pending', 'processing')`,
        [presentation.id, normalized.at],
      );
    }
    return {
      outcome: "applied",
      action: normalized.action,
      proposal: await requireProposal(client, proposal.id),
      draftStatus,
      draftVersion: nextDraftVersion,
    };
  });
}

function actionApprovalFingerprint(
  normalized: ReturnType<typeof normalizeApplyActionInput>,
): string {
  const { at: _auditTimestamp, requireReviewAttestation: _reviewGate, ...intent } = normalized;
  return operationFingerprint({ operation: "apply_action_proposal_action", ...intent });
}

async function inspectNormalizedApprovalActionReplay(
  queryable: Pick<PostgresKnowledgeDraftDataSource, "query">,
  normalized: ReturnType<typeof normalizeApplyActionInput>,
  fingerprint: string,
): Promise<ActionApprovalReplayInspection | undefined> {
  if (normalized.action === "approve") {
    const replay = await queryable.query<ApprovalRow>(
      `${approvalSelect()} WHERE operation_key = $1 OR callback_event_id = $2
       ORDER BY CASE WHEN operation_key = $1 THEN 0 ELSE 1 END LIMIT 1`,
      [normalized.operationKey, normalized.callbackEventId],
    );
    if (replay.rows[0] === undefined) return undefined;
    if (
      replay.rows[0].operation_key !== normalized.operationKey ||
      replay.rows[0].operation_fingerprint !== fingerprint
    ) throw new ActionProposalOperationConflictError();
    return buildApprovalReplayInspection(
      queryable,
      replay.rows[0].proposal_id,
      normalized.action,
    );
  }

  const replay = await queryable.query<{
    draft_id: string;
    event_type: "revision_requested" | "rejected";
    operation_fingerprint: string;
    to_version: string | number;
  }>(
    `SELECT draft_id, event_type, operation_fingerprint, to_version
     FROM knowledge_draft_events WHERE operation_key = $1`,
    [normalized.operationKey],
  );
  if (replay.rows[0] !== undefined) {
    const expectedEventType = normalized.action === "request_revision"
      ? "revision_requested"
      : "rejected";
    if (
      replay.rows[0].event_type !== expectedEventType ||
      replay.rows[0].operation_fingerprint !== fingerprint
    ) throw new ActionProposalOperationConflictError();
    const proposal = await requireProposal(queryable, normalized.proposalId);
    if (replay.rows[0].draft_id !== proposal.subjectId) {
      throw new ActionProposalOperationConflictError();
    }
    const draft = await requireDraftState(queryable, proposal.subjectId);
    return {
      result: {
        outcome: "already_applied",
        action: normalized.action,
        proposal,
        draftStatus: draft.status,
        draftVersion: Number(replay.rows[0].to_version),
      },
      ...(draft.sourceGroupId === undefined ? {} : { sourceGroupId: draft.sourceGroupId }),
    };
  }
  const callbackReplay = await queryable.query<{ operation_key: string }>(
    `SELECT operation_key FROM action_approval_presentation_events
     WHERE callback_event_id = $1`,
    [normalized.callbackEventId],
  );
  if (callbackReplay.rows[0] !== undefined) throw new ActionProposalOperationConflictError();
  return undefined;
}

async function buildApprovalReplayInspection(
  queryable: Pick<PostgresKnowledgeDraftDataSource, "query">,
  proposalId: string,
  action: ApplyActionProposalActionInput["action"],
): Promise<ActionApprovalReplayInspection> {
  const proposal = await requireProposal(queryable, proposalId);
  const draft = await requireDraftState(queryable, proposal.subjectId);
  return {
    result: {
      outcome: "already_applied",
      action,
      proposal,
      draftStatus: draft.status,
      draftVersion: draft.version,
    },
    ...(draft.sourceGroupId === undefined ? {} : { sourceGroupId: draft.sourceGroupId }),
  };
}

async function lockProposal(
  client: KnowledgeDraftTransactionClient,
  id: string,
): Promise<ProposalRow> {
  const result = await client.query<ProposalRow>(`${proposalSelect()} WHERE id = $1 FOR UPDATE`, [id]);
  if (result.rows[0] === undefined) throw new ActionProposalIneligibleError();
  return result.rows[0];
}

async function lockPublicationExecution(
  client: KnowledgeDraftTransactionClient,
  id: string,
): Promise<PublicationExecutionRow> {
  const result = await client.query<PublicationExecutionRow>(
    `${publicationExecutionSelect()} WHERE id = $1 FOR UPDATE`,
    [id],
  );
  if (result.rows[0] === undefined) throw new ActionProposalIneligibleError();
  return result.rows[0];
}

async function lockRequirement(
  client: KnowledgeDraftTransactionClient,
  id: string,
): Promise<RequirementRow> {
  const result = await client.query<RequirementRow>(
    `${requirementSelect()} WHERE id = $1 FOR UPDATE`,
    [id],
  );
  if (result.rows[0] === undefined) throw new ActionProposalIneligibleError();
  return result.rows[0];
}

async function lockApprovalPresentation(
  client: KnowledgeDraftTransactionClient,
  id: string,
): Promise<ApprovalPresentationRow> {
  const result = await client.query<ApprovalPresentationRow>(
    `${approvalPresentationSelect()} WHERE id = $1 FOR UPDATE`,
    [id],
  );
  if (result.rows[0] === undefined) throw new ActionProposalAuthorizationError();
  return result.rows[0];
}

async function requireApprovalAuthorization(
  client: KnowledgeDraftTransactionClient,
  requirement: RequirementRow,
  actorOpenId: string,
): Promise<string> {
  if (requirement.requirement_kind === "designated_owner") {
    if (requirement.role_ref_type !== "feishu_user" || requirement.role_ref !== actorOpenId) {
      throw new ActionProposalAuthorizationError();
    }
    return "designated_owner:exact_feishu_user";
  }
  if (requirement.requirement_kind !== "iris_admin_or_authorized_owner") {
    throw new ActionProposalAuthorizationError();
  }
  if (await actorHasRole(client, "iris_admin", actorOpenId)) return "iris_admin:current_grant";
  if (
    requirement.role_ref_type === "feishu_user" &&
    requirement.role_ref === actorOpenId &&
    await actorHasRole(client, "authorized_high_risk_owner", actorOpenId)
  ) return "authorized_high_risk_owner:exact_feishu_user_current_grant";
  throw new ActionProposalAuthorizationError();
}

async function actorHasRole(
  client: KnowledgeDraftTransactionClient,
  roleType: ActionRoleGrantType,
  actorOpenId: string,
): Promise<boolean> {
  const result = await client.query<{ enabled: boolean }>(
    `SELECT enabled FROM action_role_grants
     WHERE role_type = $1 AND actor_open_id = $2
     FOR SHARE`,
    [roleType, actorOpenId],
  );
  return result.rows[0]?.enabled === true;
}

function policyMatchesDraft(policy: PolicyRow, draft: DraftRevisionRow): boolean {
  return policy.space_id === draft.suggested_space_id &&
    (policy.parent_node_token ?? undefined) === (draft.suggested_parent_node_token ?? undefined) &&
    policy.allowed_risk_levels.includes(draft.risk_level) &&
    (draft.source_group_id === null || policy.allowed_group_ids.includes(draft.source_group_id));
}

async function requireDraftState(
  client: Pick<PostgresKnowledgeDraftDataSource, "query">,
  id: string,
): Promise<{ status: KnowledgeDraftStatus; version: number; sourceGroupId?: string }> {
  const result = await client.query<{
    status: string;
    version: string | number;
    source_group_id: string | null;
  }>(
    "SELECT status, version, source_group_id FROM knowledge_drafts WHERE id = $1",
    [id],
  );
  const row = result.rows[0];
  if (row === undefined || !KNOWLEDGE_DRAFT_STATUSES.includes(row.status as KnowledgeDraftStatus)) {
    throw new ActionProposalPersistenceConflictError();
  }
  return {
    status: row.status as KnowledgeDraftStatus,
    version: Number(row.version),
    ...(row.source_group_id === null ? {} : { sourceGroupId: row.source_group_id }),
  };
}

async function requireNoPublicationForDraftRevision(
  client: KnowledgeDraftTransactionClient,
  draftId: string,
  revisionNumber: number,
): Promise<void> {
  const result = await client.query<{ present: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM knowledge_publications
       WHERE draft_id = $1 AND revision_number = $2
     ) AS present`,
    [draftId, revisionNumber],
  );
  if (result.rows[0]?.present === true) throw new ActionProposalIneligibleError();
}

async function requireAllRequirementsSatisfied(
  client: KnowledgeDraftTransactionClient,
  proposalId: string,
): Promise<void> {
  const result = await client.query<{ present: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM action_approval_requirements
       WHERE proposal_id = $1 AND state <> 'satisfied'
     ) AS present`,
    [proposalId],
  );
  if (result.rows[0]?.present !== false) throw new ActionProposalIneligibleError();
}

async function buildPublicationExecutionClaimResult(
  client: KnowledgeDraftTransactionClient,
  executionRow: PublicationExecutionRow,
): Promise<ClaimApprovedPublicationExecutionResult> {
  const proposal = await requireProposal(client, executionRow.proposal_id);
  const draft = await lockDraftRevision(client, proposal.subjectId);
  const policy = await requirePolicy(client, proposal.targetPolicyId);
  return {
    outcome: "already_applied",
    proposal,
    execution: mapPublicationExecution(executionRow),
    draft: mapClaimedPublicationDraft(draft),
    policy,
  };
}

async function requirePublicationExecution(
  queryable: Pick<PostgresKnowledgeDraftDataSource, "query">,
  id: string,
): Promise<PublicationExecution> {
  const result = await queryable.query<PublicationExecutionRow>(
    `${publicationExecutionSelect()} WHERE id = $1`,
    [id],
  );
  if (result.rows[0] === undefined) throw new ActionProposalPersistenceConflictError();
  return mapPublicationExecution(result.rows[0]);
}

async function requireKnowledgePublication(
  queryable: Pick<PostgresKnowledgeDraftDataSource, "query">,
  id: string,
): Promise<KnowledgePublication> {
  const result = await queryable.query<KnowledgePublicationRow>(
    `${knowledgePublicationSelect()} WHERE id = $1`,
    [id],
  );
  if (result.rows[0] === undefined) throw new ActionProposalPersistenceConflictError();
  return mapKnowledgePublication(result.rows[0]);
}

async function publicationDraftResult(
  queryable: Pick<PostgresKnowledgeDraftDataSource, "query">,
  draftId: string,
): Promise<{ draftStatus: KnowledgeDraftStatus; draftVersion: number }> {
  const draft = await requireDraftState(queryable, draftId);
  return { draftStatus: draft.status, draftVersion: draft.version };
}

async function applyProposalDisposition(
  client: KnowledgeDraftTransactionClient,
  proposal: ProposalRow,
  _requirement: RequirementRow,
  presentation: ApprovalPresentationRow,
  input: ReturnType<typeof normalizeApplyActionInput>,
  fingerprint: string,
): Promise<ApplyActionProposalActionResult> {
  if (input.action === "approve" || input.reason === undefined) {
    throw new ActionProposalPersistenceConflictError();
  }
  const draftStatus: KnowledgeDraftStatus = input.action === "request_revision"
    ? "needs_revision"
    : "rejected";
  const draftEventType = input.action === "request_revision" ? "revision_requested" : "rejected";
  const nextDraftVersion = input.expectedSubjectVersion + 1;
  if (input.action === "request_revision") {
    await client.query(
      `UPDATE knowledge_drafts
       SET status = 'needs_revision', version = version + 1, updated_at = $2
       WHERE id = $1 AND version = $3 AND status = 'pending_review'`,
      [proposal.subject_id, input.at, input.expectedSubjectVersion],
    );
  } else {
    await client.query(
      `UPDATE knowledge_drafts
       SET status = 'rejected', version = version + 1, rejected_at = $2,
           rejected_by = $3, rejection_reason = $4, updated_at = $2
       WHERE id = $1 AND version = $5 AND status = 'pending_review'`,
      [proposal.subject_id, input.at, input.actorOpenId, input.reason, input.expectedSubjectVersion],
    );
  }
  await client.query(
    `INSERT INTO knowledge_draft_events (
      id, draft_id, event_type, from_version, to_version, operation_key,
      operation_fingerprint, actor, reason, revision_number, created_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      randomUUID(),
      proposal.subject_id,
      draftEventType,
      input.expectedSubjectVersion,
      nextDraftVersion,
      input.operationKey,
      fingerprint,
      input.actorOpenId,
      input.reason,
      input.expectedSubjectRevision,
      input.at,
    ],
  );
  await client.query(
    `UPDATE action_approval_requirements
     SET state = 'invalidated', satisfied_actor_open_id = NULL,
         satisfied_source_type = NULL, satisfied_source_id = NULL,
         version = version + 1, updated_at = $2
     WHERE proposal_id = $1 AND state <> 'invalidated'`,
    [proposal.id, input.at],
  );
  const nextProposalVersion = input.expectedProposalVersion + 1;
  await client.query(
    `UPDATE action_proposals
     SET status = 'cancelled', version = version + 1, updated_at = $2
     WHERE id = $1 AND version = $3`,
    [proposal.id, input.at, input.expectedProposalVersion],
  );
  await client.query(
    `INSERT INTO action_events (
      id, proposal_id, event_type, actor_open_id, operation_key,
      from_version, to_version, reason_code, created_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      randomUUID(),
      proposal.id,
      draftEventType,
      input.actorOpenId,
      derivedOperationKey(`action-${draftEventType}`, input.operationKey),
      input.expectedProposalVersion,
      nextProposalVersion,
      input.action === "request_revision" ? "reviewer_requested_revision" : "reviewer_rejected",
      input.at,
    ],
  );
  await closeActionPresentation(client, presentation, input, draftEventType);
  return {
    outcome: "applied",
    action: input.action,
    proposal: await requireProposal(client, proposal.id),
    draftStatus,
    draftVersion: nextDraftVersion,
  };
}

async function closeActionPresentation(
  client: KnowledgeDraftTransactionClient,
  presentation: ApprovalPresentationRow,
  input: ReturnType<typeof normalizeApplyActionInput>,
  eventType: "approved" | "revision_requested" | "rejected",
): Promise<void> {
  const fromVersion = Number(presentation.version);
  await client.query(
    `UPDATE action_approval_presentations
     SET state = 'closed', version = version + 1, closed_at = $2
     WHERE id = $1 AND version = $3 AND state = 'active'`,
    [presentation.id, input.at, fromVersion],
  );
  await client.query(
    `INSERT INTO action_approval_presentation_events (
      id, presentation_id, event_type, actor_open_id, operation_key,
      callback_event_id, from_version, to_version, created_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      randomUUID(),
      presentation.id,
      eventType,
      input.actorOpenId,
      derivedOperationKey(`action-presentation-${eventType}`, input.operationKey),
      input.callbackEventId,
      fromVersion,
      fromVersion + 1,
      input.at,
    ],
  );
}

async function upsertTargetPolicy(
  dataSource: PostgresKnowledgeDraftDataSource,
  input: UpsertPublicationTargetPolicyInput,
): Promise<PolicyMutationResult> {
  const normalized = normalizePolicyInput(input);
  const fingerprint = operationFingerprint({ operation: "upsert_target_policy", ...normalized });
  return withTransaction(dataSource, async (client) => {
    await lockOperation(client, normalized.operationKey);
    const replay = await client.query<OperationRow & { policy_id: string }>(
      `SELECT operation_fingerprint, policy_id, resulting_version
       FROM action_target_policy_operations WHERE operation_key = $1`,
      [normalized.operationKey],
    );
    if (replay.rows[0] !== undefined) {
      if (replay.rows[0].operation_fingerprint !== fingerprint) {
        throw new ActionProposalOperationConflictError();
      }
      return {
        outcome: "already_applied",
        policy: await requirePolicy(client, replay.rows[0].policy_id),
      };
    }

    const existing = await client.query<PolicyRow>(`${policySelect()} WHERE id = $1 FOR UPDATE`, [
      normalized.id,
    ]);
    const row = existing.rows[0];
    if ((row === undefined ? 0 : Number(row.version)) !== normalized.expectedVersion) {
      throw new ActionProposalVersionConflictError();
    }
    const nextVersion = normalized.expectedVersion + 1;
    if (row === undefined) {
      await client.query(
        `INSERT INTO knowledge_publication_target_policies (
          id, space_id, parent_node_token, display_name, allowed_group_ids,
          allowed_risk_levels, enabled, version, operation_key, operation_fingerprint,
          created_by, updated_by, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, 1, $8, $9, $10, $10, $11, $11)`,
        [
          normalized.id,
          normalized.spaceId,
          normalized.parentNodeToken ?? null,
          normalized.displayName,
          normalized.allowedGroupIds,
          normalized.allowedRiskLevels,
          normalized.enabled,
          normalized.operationKey,
          fingerprint,
          normalized.operator,
          normalized.at,
        ],
      );
    } else {
      await client.query(
        `UPDATE knowledge_publication_target_policies
         SET space_id = $2, parent_node_token = $3, display_name = $4,
             allowed_group_ids = $5, allowed_risk_levels = $6, enabled = $7,
             version = version + 1, operation_key = $8, operation_fingerprint = $9,
             updated_by = $10, updated_at = $11
         WHERE id = $1 AND version = $12`,
        [
          normalized.id,
          normalized.spaceId,
          normalized.parentNodeToken ?? null,
          normalized.displayName,
          normalized.allowedGroupIds,
          normalized.allowedRiskLevels,
          normalized.enabled,
          normalized.operationKey,
          fingerprint,
          normalized.operator,
          normalized.at,
          normalized.expectedVersion,
        ],
      );
    }
    await client.query(
      `INSERT INTO action_target_policy_operations (
        operation_key, operation_fingerprint, policy_id, resulting_version, created_at
      ) VALUES ($1, $2, $3, $4, $5)`,
      [normalized.operationKey, fingerprint, normalized.id, nextVersion, normalized.at],
    );
    return { outcome: "applied", policy: await requirePolicy(client, normalized.id) };
  });
}

async function upsertRoleGrant(
  dataSource: PostgresKnowledgeDraftDataSource,
  input: UpsertActionRoleGrantInput,
): Promise<RoleGrantMutationResult> {
  const normalized = normalizeRoleGrantInput(input);
  const fingerprint = operationFingerprint({ operation: "upsert_role_grant", ...normalized });
  return withTransaction(dataSource, async (client) => {
    await lockOperation(client, normalized.operationKey);
    const replay = await client.query<OperationRow & { role_type: ActionRoleGrantType; actor_open_id: string }>(
      `SELECT operation_fingerprint, role_type, actor_open_id, resulting_version
       FROM action_role_grant_operations WHERE operation_key = $1`,
      [normalized.operationKey],
    );
    if (replay.rows[0] !== undefined) {
      if (replay.rows[0].operation_fingerprint !== fingerprint) {
        throw new ActionProposalOperationConflictError();
      }
      return {
        outcome: "already_applied",
        grant: await requireGrant(client, replay.rows[0].role_type, replay.rows[0].actor_open_id),
      };
    }
    const existing = await client.query<GrantRow>(
      `${grantSelect()} WHERE role_type = $1 AND actor_open_id = $2 FOR UPDATE`,
      [normalized.roleType, normalized.actorOpenId],
    );
    const row = existing.rows[0];
    if ((row === undefined ? 0 : Number(row.version)) !== normalized.expectedVersion) {
      throw new ActionProposalVersionConflictError();
    }
    const nextVersion = normalized.expectedVersion + 1;
    if (row === undefined) {
      await client.query(
        `INSERT INTO action_role_grants (
          role_type, actor_open_id, enabled, version, operation_key, operation_fingerprint,
          created_by, updated_by, created_at, updated_at
        ) VALUES ($1, $2, $3, 1, $4, $5, $6, $6, $7, $7)`,
        [
          normalized.roleType,
          normalized.actorOpenId,
          normalized.enabled,
          normalized.operationKey,
          fingerprint,
          normalized.operator,
          normalized.at,
        ],
      );
    } else {
      await client.query(
        `UPDATE action_role_grants
         SET enabled = $3, version = version + 1, operation_key = $4,
             operation_fingerprint = $5, updated_by = $6, updated_at = $7
         WHERE role_type = $1 AND actor_open_id = $2 AND version = $8`,
        [
          normalized.roleType,
          normalized.actorOpenId,
          normalized.enabled,
          normalized.operationKey,
          fingerprint,
          normalized.operator,
          normalized.at,
          normalized.expectedVersion,
        ],
      );
    }
    await client.query(
      `INSERT INTO action_role_grant_operations (
        operation_key, operation_fingerprint, role_type, actor_open_id, resulting_version, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        normalized.operationKey,
        fingerprint,
        normalized.roleType,
        normalized.actorOpenId,
        nextVersion,
        normalized.at,
      ],
    );
    return {
      outcome: "applied",
      grant: await requireGrant(client, normalized.roleType, normalized.actorOpenId),
    };
  });
}

async function createProposal(
  dataSource: PostgresKnowledgeDraftDataSource,
  input: CreateActionProposalInput,
): Promise<ActionProposalMutationResult> {
  const normalized = normalizeCreateProposalInput(input);
  const fingerprint = operationFingerprint({ operation: "create_proposal", ...normalized });
  return withTransaction(dataSource, async (client) => {
    await lockOperation(client, normalized.operationKey);
    const replay = await client.query<ProposalRow>(
      `${proposalSelect()} WHERE operation_key = $1`,
      [normalized.operationKey],
    );
    if (replay.rows[0] !== undefined) {
      if (replay.rows[0].operation_fingerprint !== fingerprint) {
        throw new ActionProposalOperationConflictError();
      }
      return { outcome: "already_applied", proposal: mapProposal(replay.rows[0]) };
    }

    const draft = await lockDraftRevision(client, normalized.draftId);
    if (
      draft.status !== "pending_review" ||
      Number(draft.current_revision_number) !== normalized.expectedRevision ||
      Number(draft.version) !== normalized.expectedDraftVersion
    ) throw new ActionProposalIneligibleError();
    await validateDraftEvidence(client, draft);

    const policy = await lockPolicy(client, normalized.targetPolicyId);
    if (
      !policy.enabled ||
      Number(policy.version) !== normalized.expectedTargetPolicyVersion ||
      policy.space_id !== draft.suggested_space_id ||
      (policy.parent_node_token ?? undefined) !== (draft.suggested_parent_node_token ?? undefined) ||
      !policy.allowed_risk_levels.includes(draft.risk_level) ||
      (draft.source_group_id !== null && !policy.allowed_group_ids.includes(draft.source_group_id))
    ) throw new ActionProposalIneligibleError();

    const groupConfirmation = draft.source_group_id === null
      ? undefined
      : await requireGroupConfirmation(client, draft.id, normalized.expectedRevision);
    const reviewer = mapReviewer(draft);
    const requirements = buildApprovalRequirementSnapshot({
      ...(draft.source_group_id === null ? {} : { sourceGroupId: draft.source_group_id }),
      riskLevel: draft.risk_level,
      ...(reviewer === undefined ? {} : { reviewer }),
      ...(groupConfirmation === undefined ? {} : { groupConfirmation: {
        actorOpenId: groupConfirmation.actor_open_id,
        presentationId: groupConfirmation.presentation_id,
      } }),
      targetPolicy: { id: policy.id, version: Number(policy.version) },
    });
    const status: ActionProposalStatus = requirements.every((item) => item.satisfiedBy !== undefined)
      ? "approved"
      : "pending_approval";

    await client.query(
      `INSERT INTO action_proposals (
        id, action_type, subject_type, subject_id, subject_revision, subject_version,
        target_policy_id, target_policy_version, risk_level, status,
        operation_key, operation_fingerprint, version, created_at, updated_at
      ) VALUES ($1, 'publish_knowledge_draft', 'knowledge_draft', $2, $3, $4,
        $5, $6, $7, $8, $9, $10, 1, $11, $11)`,
      [
        normalized.proposalId,
        normalized.draftId,
        normalized.expectedRevision,
        normalized.expectedDraftVersion,
        policy.id,
        Number(policy.version),
        draft.risk_level,
        status,
        normalized.operationKey,
        fingerprint,
        normalized.at,
      ],
    );
    for (const requirement of requirements) {
      const requirementId = randomUUID();
      await client.query(
        `INSERT INTO action_approval_requirements (
          id, proposal_id, requirement_kind, role_ref_type, role_ref,
          target_policy_id, target_policy_version, state,
          satisfied_actor_open_id, satisfied_source_type, satisfied_source_id,
          version, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 1, $12, $12)`,
        [
          requirementId,
          normalized.proposalId,
          requirement.kind,
          requirement.roleRefType,
          requirement.roleRef ?? null,
          requirement.targetPolicyId,
          requirement.targetPolicyVersion,
          requirement.satisfiedBy === undefined ? "pending" : "satisfied",
          requirement.satisfiedBy?.actorOpenId ?? null,
          requirement.satisfiedBy?.sourceType ?? null,
          requirement.satisfiedBy?.sourceId ?? null,
          normalized.at,
        ],
      );
      const recipients = await listApprovalPresentationRecipients(client, requirement);
      for (const recipientOpenId of recipients) {
        const presentationId = randomUUID();
        const presentationOperationKey = derivedOperationKey("action-approval-presentation", {
          proposalId: normalized.proposalId,
          requirementId,
          recipientOpenId,
          proposalVersion: 1,
        });
        const presentationFingerprint = operationFingerprint({
          proposalId: normalized.proposalId,
          requirementId,
          recipientOpenId,
          proposalVersion: 1,
        });
        await client.query(
          `INSERT INTO action_approval_presentations (
            id, proposal_id, requirement_id, proposal_version, recipient_open_id,
            state, operation_key, operation_fingerprint, version, created_at
          ) VALUES ($1, $2, $3, 1, $4, 'pending_send', $5, $6, 1, $7)`,
          [
            presentationId,
            normalized.proposalId,
            requirementId,
            recipientOpenId,
            presentationOperationKey,
            presentationFingerprint,
            normalized.at,
          ],
        );
        await client.query(
          `INSERT INTO action_approval_presentation_events (
            id, presentation_id, event_type, operation_key, from_version, to_version, created_at
          ) VALUES ($1, $2, 'created', $3, NULL, 1, $4)`,
          [
            randomUUID(),
            presentationId,
            derivedOperationKey("action-approval-presentation-created", presentationOperationKey),
            normalized.at,
          ],
        );
        await client.query(
          `INSERT INTO action_approval_presentation_outbox (
            id, presentation_id, idempotency_key, state, attempts, created_at, updated_at
          ) VALUES ($1, $2, $3, 'pending', 0, $4, $4)`,
          [
            randomUUID(),
            presentationId,
            `action-approval-send:${presentationId}`,
            normalized.at,
          ],
        );
      }
    }
    await client.query(
      `INSERT INTO action_events (
        id, proposal_id, event_type, operation_key, from_version, to_version,
        reason_code, created_at
      ) VALUES ($1, $2, 'created', $3, NULL, 1, $4, $5)`,
      [
        randomUUID(),
        normalized.proposalId,
        `action-proposal-created:${operationFingerprint({
          operation: "action_proposal_created",
          proposalOperationKey: normalized.operationKey,
        })}`,
        status === "approved" ? "requirements_satisfied_at_creation" : null,
        normalized.at,
      ],
    );
    return {
      outcome: "applied",
      proposal: await requireProposal(client, normalized.proposalId),
    };
  });
}

async function listApprovalPresentationRecipients(
  client: KnowledgeDraftTransactionClient,
  requirement: ActionApprovalRequirementSnapshot,
): Promise<string[]> {
  if (requirement.satisfiedBy !== undefined) return [];
  if (requirement.kind === "designated_owner") {
    return requirement.roleRefType === "feishu_user" && requirement.roleRef !== undefined
      ? [requirement.roleRef]
      : [];
  }
  if (requirement.kind !== "iris_admin_or_authorized_owner") return [];
  const result = await client.query<{ actor_open_id: string }>(
    `SELECT actor_open_id
     FROM action_role_grants
     WHERE enabled = TRUE AND (
       role_type = 'iris_admin'
       OR (role_type = 'authorized_high_risk_owner' AND actor_open_id = $1)
     )
     ORDER BY actor_open_id ASC`,
    [requirement.roleRefType === "feishu_user" ? requirement.roleRef ?? null : null],
  );
  return [...new Set(result.rows.map((row) => row.actor_open_id))];
}

async function loadProposalContext(
  dataSource: PostgresKnowledgeDraftDataSource,
  id: string,
): Promise<ActionProposalContext | undefined> {
  const proposalResult = await dataSource.query<ProposalRow>(`${proposalSelect()} WHERE id = $1`, [id]);
  if (proposalResult.rows[0] === undefined) return undefined;
  const [requirements, approvals] = await Promise.all([
    dataSource.query<RequirementRow>(
      `${requirementSelect()} WHERE proposal_id = $1
       ORDER BY CASE requirement_kind
         WHEN 'group_confirmation' THEN 1
         WHEN 'designated_owner' THEN 2
         WHEN 'iris_admin_or_authorized_owner' THEN 3
         ELSE 4
       END ASC, created_at ASC, id ASC`,
      [id],
    ),
    dataSource.query<ApprovalRow>(
      `${approvalSelect()} WHERE proposal_id = $1 ORDER BY created_at ASC, id ASC`,
      [id],
    ),
  ]);
  return {
    proposal: mapProposal(proposalResult.rows[0]),
    requirements: requirements.rows.map(mapRequirement),
    approvals: approvals.rows.map(mapApproval),
  };
}

async function lockDraftRevision(
  client: KnowledgeDraftTransactionClient,
  id: string,
): Promise<DraftRevisionRow> {
  const result = await client.query<DraftRevisionRow>(
    `SELECT draft.id, draft.source_group_id, draft.status, draft.current_revision_number,
            draft.version, revision.title, revision.content, revision.risk_level,
            revision.reviewer_type, revision.reviewer_ref,
            revision.suggested_space_id, revision.suggested_parent_node_token
     FROM knowledge_drafts draft
     JOIN knowledge_draft_revisions revision
       ON revision.draft_id = draft.id
      AND revision.revision_number = draft.current_revision_number
     WHERE draft.id = $1 FOR UPDATE OF draft`,
    [id],
  );
  if (result.rows[0] === undefined) throw new ActionProposalIneligibleError();
  return result.rows[0];
}

async function lockPolicy(
  client: KnowledgeDraftTransactionClient,
  id: string,
): Promise<PolicyRow> {
  const result = await client.query<PolicyRow>(`${policySelect()} WHERE id = $1 FOR UPDATE`, [id]);
  if (result.rows[0] === undefined) throw new ActionProposalIneligibleError();
  return result.rows[0];
}

async function requireGroupConfirmation(
  client: KnowledgeDraftTransactionClient,
  draftId: string,
  revision: number,
): Promise<GroupConfirmationRow> {
  const result = await client.query<GroupConfirmationRow>(
    `SELECT actor_open_id, presentation_id FROM knowledge_draft_group_confirmations
     WHERE draft_id = $1 AND revision_number = $2`,
    [draftId, revision],
  );
  if (result.rows[0] === undefined) throw new ActionProposalIneligibleError();
  return result.rows[0];
}

async function validateDraftEvidence(
  client: KnowledgeDraftTransactionClient,
  draft: DraftRevisionRow,
): Promise<void> {
  const evidence = await loadDraftEvidence(client, draft.id, Number(draft.current_revision_number));
  await validateCurrentKnowledgeDraftEvidence({
    queryable: client,
    sourceGroupId: draft.source_group_id ?? undefined,
    evidence,
  });
}

async function loadDraftEvidence(
  queryable: Pick<PostgresKnowledgeDraftDataSource, "query">,
  draftId: string,
  revision: number,
): Promise<KnowledgeDraftEvidenceReference[]> {
  const result = await queryable.query<EvidenceRow>(
    `SELECT evidence_type, reference_id, source_group_id, entity_version, source_updated_at
     FROM knowledge_draft_revision_evidence
     WHERE draft_id = $1 AND revision_number = $2
     ORDER BY evidence_type ASC, reference_id ASC`,
    [draftId, revision],
  );
  return result.rows.map(mapEvidence);
}

function mapEvidence(row: EvidenceRow): KnowledgeDraftEvidenceReference {
  if (row.evidence_type === "conversation_message") {
    return {
      type: "conversation_message",
      id: row.reference_id,
      groupId: requireDatabaseValue(row.source_group_id),
    };
  }
  if (row.evidence_type === "discussion_thread" || row.evidence_type === "action_item") {
    return {
      type: row.evidence_type,
      id: row.reference_id,
      groupId: requireDatabaseValue(row.source_group_id),
      entityVersion: Number(requireDatabaseValue(row.entity_version)),
    };
  }
  return {
    type: "document_source",
    id: row.reference_id,
    expectedUpdatedAt: requireDate(requireDatabaseValue(row.source_updated_at)),
  };
}

function mapReviewer(row: DraftRevisionRow): KnowledgeDraftReviewer | undefined {
  return row.reviewer_type === null || row.reviewer_ref === null
    ? undefined
    : { type: row.reviewer_type, ref: row.reviewer_ref };
}

async function requirePolicy(
  queryable: Pick<PostgresKnowledgeDraftDataSource, "query">,
  id: string,
): Promise<PublicationTargetPolicy> {
  const result = await queryable.query<PolicyRow>(`${policySelect()} WHERE id = $1`, [id]);
  if (result.rows[0] === undefined) throw new ActionProposalPersistenceConflictError();
  return mapPolicy(result.rows[0]);
}

async function requireGrant(
  queryable: Pick<PostgresKnowledgeDraftDataSource, "query">,
  roleType: ActionRoleGrantType,
  actorOpenId: string,
): Promise<ActionRoleGrant> {
  const result = await queryable.query<GrantRow>(
    `${grantSelect()} WHERE role_type = $1 AND actor_open_id = $2`,
    [roleType, actorOpenId],
  );
  if (result.rows[0] === undefined) throw new ActionProposalPersistenceConflictError();
  return mapGrant(result.rows[0]);
}

async function requireProposal(
  queryable: Pick<PostgresKnowledgeDraftDataSource, "query">,
  id: string,
): Promise<ActionProposal> {
  const result = await queryable.query<ProposalRow>(`${proposalSelect()} WHERE id = $1`, [id]);
  if (result.rows[0] === undefined) throw new ActionProposalPersistenceConflictError();
  return mapProposal(result.rows[0]);
}

function policySelect(): string {
  return `SELECT id, space_id, parent_node_token, display_name, allowed_group_ids,
                 allowed_risk_levels, enabled, version, created_at, updated_at
          FROM knowledge_publication_target_policies`;
}

function grantSelect(): string {
  return `SELECT role_type, actor_open_id, enabled, version, created_at, updated_at
          FROM action_role_grants`;
}

function proposalSelect(): string {
  return `SELECT id, action_type, subject_type, subject_id, subject_revision, subject_version,
                 target_policy_id, target_policy_version, risk_level, status, operation_key,
                 operation_fingerprint, version, created_at, updated_at
          FROM action_proposals`;
}

function requirementSelect(): string {
  return `SELECT id, proposal_id, requirement_kind, role_ref_type, role_ref,
                 target_policy_id, target_policy_version, state, satisfied_actor_open_id,
                 satisfied_source_type, satisfied_source_id, version, created_at, updated_at
          FROM action_approval_requirements`;
}

function approvalSelect(): string {
  return `SELECT id, proposal_id, requirement_id, actor_open_id, source_presentation_id,
                 callback_event_id, subject_revision, subject_version, operation_key,
                 operation_fingerprint, created_at
          FROM action_approvals`;
}

function actionReviewAttestationSelect(): string {
  return `SELECT proposal_id, actor_open_id, subject_revision, subject_version, proposal_version,
                 content_hash, session_id_hash, operation_key, operation_fingerprint
          FROM action_review_attestations`;
}

function actionEventSelect(): string {
  return `SELECT id, proposal_id, event_type, actor_open_id, from_version, to_version,
                 reason_code, created_at
          FROM action_events`;
}

function approvalPresentationSelect(): string {
  return `SELECT id, proposal_id, requirement_id, proposal_version, recipient_open_id,
                 state, message_id, operation_key, version, created_at, activated_at, closed_at
          FROM action_approval_presentations`;
}

function approvalOutboxSelect(alias?: string): string {
  const prefix = alias === undefined ? "" : `${alias}.`;
  const from = alias === undefined
    ? "action_approval_presentation_outbox"
    : `action_approval_presentation_outbox ${alias}`;
  return `SELECT ${prefix}id, ${prefix}presentation_id, ${prefix}idempotency_key,
                 ${prefix}state, ${prefix}attempts, ${prefix}worker_id, ${prefix}lease_until,
                 ${prefix}retry_at, ${prefix}error_code, ${prefix}created_at, ${prefix}updated_at
          FROM ${from}`;
}

function publicationExecutionSelect(): string {
  return `SELECT id, proposal_id, attempt_number, state, request_fingerprint, provider,
                 response_classification, remote_node_token, remote_document_token,
                 version, retry_at, created_at, updated_at
          FROM action_executions`;
}

function knowledgePublicationSelect(): string {
  return `SELECT id, proposal_id, execution_id, draft_id, revision_number, draft_version,
                 target_policy_id, target_policy_version, space_id, remote_node_token,
                 remote_document_token, remote_document_type, remote_document_version,
                 content_hash, permission_check_summary, operation_key, published_at, created_at
          FROM knowledge_publications`;
}

function mapPolicy(row: PolicyRow): PublicationTargetPolicy {
  return {
    id: row.id,
    spaceId: row.space_id,
    ...(row.parent_node_token === null ? {} : { parentNodeToken: row.parent_node_token }),
    displayName: row.display_name,
    allowedGroupIds: [...row.allowed_group_ids],
    allowedRiskLevels: [...row.allowed_risk_levels],
    enabled: row.enabled,
    version: Number(row.version),
    createdAt: requireDate(row.created_at),
    updatedAt: requireDate(row.updated_at),
  };
}

function mapClaimedPublicationDraft(row: DraftRevisionRow): ClaimedPublicationDraft {
  const suggestedPublication = row.suggested_space_id === null &&
    row.suggested_parent_node_token === null
    ? undefined
    : {
        ...(row.suggested_space_id === null ? {} : { spaceId: row.suggested_space_id }),
        ...(row.suggested_parent_node_token === null
          ? {}
          : { parentNodeToken: row.suggested_parent_node_token }),
      };
  return {
    id: row.id,
    ...(row.source_group_id === null ? {} : { sourceGroupId: row.source_group_id }),
    revisionNumber: Number(row.current_revision_number),
    version: Number(row.version),
    title: row.title,
    content: row.content,
    riskLevel: row.risk_level,
    ...(suggestedPublication === undefined ? {} : { suggestedPublication }),
  };
}

function mapPublicationExecution(row: PublicationExecutionRow): PublicationExecution {
  return {
    id: row.id,
    proposalId: row.proposal_id,
    attemptNumber: Number(row.attempt_number),
    state: row.state,
    requestFingerprint: row.request_fingerprint,
    provider: row.provider,
    ...(row.response_classification === null ? {} : { responseClassification: row.response_classification }),
    ...(row.remote_node_token === null ? {} : { remoteNodeToken: row.remote_node_token }),
    ...(row.remote_document_token === null ? {} : { remoteDocumentToken: row.remote_document_token }),
    version: Number(row.version),
    ...(row.retry_at === null ? {} : { retryAt: requireDate(row.retry_at) }),
    createdAt: requireDate(row.created_at),
    updatedAt: requireDate(row.updated_at),
  };
}

function mapKnowledgePublication(row: KnowledgePublicationRow): KnowledgePublication {
  return {
    id: row.id,
    proposalId: row.proposal_id,
    executionId: row.execution_id,
    draftId: row.draft_id,
    revisionNumber: Number(row.revision_number),
    draftVersion: Number(row.draft_version),
    targetPolicyId: row.target_policy_id,
    targetPolicyVersion: Number(row.target_policy_version),
    spaceId: row.space_id,
    remoteNodeToken: row.remote_node_token,
    remoteDocumentToken: row.remote_document_token,
    remoteDocumentType: row.remote_document_type,
    ...(row.remote_document_version === null ? {} : { remoteDocumentVersion: Number(row.remote_document_version) }),
    contentHash: row.content_hash,
    permissionCheckSummary: row.permission_check_summary,
    operationKey: row.operation_key,
    publishedAt: requireDate(row.published_at),
    createdAt: requireDate(row.created_at),
  };
}

function mapGrant(row: GrantRow): ActionRoleGrant {
  return {
    roleType: row.role_type,
    actorOpenId: row.actor_open_id,
    enabled: row.enabled,
    version: Number(row.version),
    createdAt: requireDate(row.created_at),
    updatedAt: requireDate(row.updated_at),
  };
}

function mapProposal(row: ProposalRow): ActionProposal {
  return {
    id: row.id,
    actionType: row.action_type,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    subjectRevision: Number(row.subject_revision),
    subjectVersion: Number(row.subject_version),
    targetPolicyId: row.target_policy_id,
    targetPolicyVersion: Number(row.target_policy_version),
    riskLevel: row.risk_level,
    status: row.status,
    operationKey: row.operation_key,
    version: Number(row.version),
    createdAt: requireDate(row.created_at),
    updatedAt: requireDate(row.updated_at),
  };
}

function mapRequirement(row: RequirementRow): ActionApprovalRequirement {
  return {
    id: row.id,
    proposalId: row.proposal_id,
    kind: row.requirement_kind,
    roleRefType: row.role_ref_type,
    ...(row.role_ref === null ? {} : { roleRef: row.role_ref }),
    targetPolicyId: row.target_policy_id,
    targetPolicyVersion: Number(row.target_policy_version),
    state: row.state,
    ...(row.satisfied_actor_open_id === null
      ? {}
      : { satisfiedActorOpenId: row.satisfied_actor_open_id }),
    ...(row.satisfied_source_type === null
      ? {}
      : { satisfiedSourceType: row.satisfied_source_type }),
    ...(row.satisfied_source_id === null ? {} : { satisfiedSourceId: row.satisfied_source_id }),
    version: Number(row.version),
    createdAt: requireDate(row.created_at),
    updatedAt: requireDate(row.updated_at),
  };
}

function mapApproval(row: ApprovalRow): ActionApproval {
  return {
    id: row.id,
    proposalId: row.proposal_id,
    requirementId: row.requirement_id,
    actorOpenId: row.actor_open_id,
    sourcePresentationId: row.source_presentation_id,
    callbackEventId: row.callback_event_id,
    subjectRevision: Number(row.subject_revision),
    subjectVersion: Number(row.subject_version),
    operationKey: row.operation_key,
    createdAt: requireDate(row.created_at),
  };
}

function mapActionEvent(row: ActionEventRow): ActionProposalEvent {
  return {
    id: row.id,
    proposalId: row.proposal_id,
    eventType: row.event_type,
    ...(row.actor_open_id === null ? {} : { actorOpenId: row.actor_open_id }),
    ...(row.from_version === null ? {} : { fromVersion: Number(row.from_version) }),
    toVersion: Number(row.to_version),
    ...(row.reason_code === null ? {} : { reasonCode: row.reason_code }),
    createdAt: requireDate(row.created_at),
  };
}

function mapApprovalPresentation(row: ApprovalPresentationRow): ActionApprovalPresentation {
  return {
    id: row.id,
    proposalId: row.proposal_id,
    requirementId: row.requirement_id,
    proposalVersion: Number(row.proposal_version),
    recipientOpenId: row.recipient_open_id,
    state: row.state,
    ...(row.message_id === null ? {} : { messageId: row.message_id }),
    operationKey: row.operation_key,
    version: Number(row.version),
    createdAt: requireDate(row.created_at),
    ...(row.activated_at === null ? {} : { activatedAt: requireDate(row.activated_at) }),
    ...(row.closed_at === null ? {} : { closedAt: requireDate(row.closed_at) }),
  };
}

function normalizePolicyInput(input: UpsertPublicationTargetPolicyInput) {
  return {
    id: requireReference("id", input.id),
    spaceId: requireReference("spaceId", input.spaceId),
    ...(input.parentNodeToken === undefined
      ? {}
      : { parentNodeToken: requireReference("parentNodeToken", input.parentNodeToken) }),
    displayName: requireBoundedString("displayName", input.displayName, 256),
    allowedGroupIds: normalizeReferenceList("allowedGroupIds", input.allowedGroupIds, true),
    allowedRiskLevels: normalizeRiskLevels(input.allowedRiskLevels),
    enabled: requireBoolean("enabled", input.enabled),
    expectedVersion: requireNonnegativeInteger("expectedVersion", input.expectedVersion),
    operationKey: requireReference("operationKey", input.operationKey),
    operator: requireReference("operator", input.operator),
    at: requireDate(input.at),
  };
}

function normalizeRoleGrantInput(input: UpsertActionRoleGrantInput) {
  return {
    roleType: requireRoleType(input.roleType),
    actorOpenId: requireReference("actorOpenId", input.actorOpenId),
    enabled: requireBoolean("enabled", input.enabled),
    expectedVersion: requireNonnegativeInteger("expectedVersion", input.expectedVersion),
    operationKey: requireReference("operationKey", input.operationKey),
    operator: requireReference("operator", input.operator),
    at: requireDate(input.at),
  };
}

function normalizeCreateProposalInput(input: CreateActionProposalInput) {
  return {
    proposalId: requireReference("proposalId", input.proposalId),
    draftId: requireReference("draftId", input.draftId),
    expectedRevision: requirePositiveInteger("expectedRevision", input.expectedRevision),
    expectedDraftVersion: requirePositiveInteger("expectedDraftVersion", input.expectedDraftVersion),
    targetPolicyId: requireReference("targetPolicyId", input.targetPolicyId),
    expectedTargetPolicyVersion: requirePositiveInteger(
      "expectedTargetPolicyVersion",
      input.expectedTargetPolicyVersion,
    ),
    operationKey: requireReference("operationKey", input.operationKey),
    at: requireDate(input.at),
  };
}

function normalizeApplyActionInput(input: ApplyActionProposalActionInput) {
  const action = input.action;
  if (!(action === "approve" || action === "request_revision" || action === "reject")) {
    throw new Error("action is invalid");
  }
  let reason: string | undefined;
  if (action === "approve") {
    if (input.reason !== undefined || input.rejectionConfirmed !== undefined) {
      throw new Error("approval action contains unsupported fields");
    }
  } else {
    reason = requireBoundedReason(input.reason);
    if (action === "reject" && input.rejectionConfirmed !== true) {
      throw new Error("rejection confirmation is required");
    }
    if (action === "request_revision" && input.rejectionConfirmed !== undefined) {
      throw new Error("revision action contains unsupported fields");
    }
  }
  return {
    proposalId: requireReference("proposalId", input.proposalId),
    requirementId: requireReference("requirementId", input.requirementId),
    expectedProposalVersion: requirePositiveInteger(
      "expectedProposalVersion",
      input.expectedProposalVersion,
    ),
    expectedSubjectRevision: requirePositiveInteger(
      "expectedSubjectRevision",
      input.expectedSubjectRevision,
    ),
    expectedSubjectVersion: requirePositiveInteger(
      "expectedSubjectVersion",
      input.expectedSubjectVersion,
    ),
    expectedTargetPolicyVersion: requirePositiveInteger(
      "expectedTargetPolicyVersion",
      input.expectedTargetPolicyVersion,
    ),
    sourcePresentationId: requireReference("sourcePresentationId", input.sourcePresentationId),
    callbackEventId: requireReference("callbackEventId", input.callbackEventId),
    actorOpenId: requireReference("actorOpenId", input.actorOpenId),
    action,
    requireReviewAttestation: requireBoolean(
      "requireReviewAttestation",
      input.requireReviewAttestation,
    ),
    ...(reason === undefined ? {} : { reason }),
    ...(action === "reject" ? { rejectionConfirmed: true as const } : {}),
    operationKey: requireReference("operationKey", input.operationKey),
    at: requireDate(input.at),
  };
}

function normalizeReviewAttestationInput(input: RecordActionReviewAttestationInput) {
  return {
    ...normalizeCurrentReviewAttestationInput(input),
    sessionIdHash: requireSha256("sessionIdHash", input.sessionIdHash),
    operationKey: requireReference("operationKey", input.operationKey),
    at: requireDate(input.at),
  };
}

function normalizeCurrentReviewAttestationInput(input: CurrentActionReviewAttestationInput) {
  return {
    proposalId: requireReference("proposalId", input.proposalId),
    actorOpenId: requireReference("actorOpenId", input.actorOpenId),
    expectedProposalVersion: requirePositiveInteger(
      "expectedProposalVersion",
      input.expectedProposalVersion,
    ),
    expectedSubjectRevision: requirePositiveInteger(
      "expectedSubjectRevision",
      input.expectedSubjectRevision,
    ),
    expectedSubjectVersion: requirePositiveInteger(
      "expectedSubjectVersion",
      input.expectedSubjectVersion,
    ),
    expectedContentHash: requireSha256("expectedContentHash", input.expectedContentHash),
  };
}

function normalizeClaimPublicationExecutionInput(input: ClaimApprovedPublicationExecutionInput) {
  return {
    proposalId: requireReference("proposalId", input.proposalId),
    expectedProposalVersion: requirePositiveInteger(
      "expectedProposalVersion",
      input.expectedProposalVersion,
    ),
    runtimeGate: normalizePublicationRuntimeGate(input.runtimeGate),
    workerId: requireReference("workerId", input.workerId),
    operationKey: requireReference("operationKey", input.operationKey),
    at: requireDate(input.at),
  };
}

function normalizePublicationRuntimeGate(input: ClaimApprovedPublicationExecutionInput["runtimeGate"]) {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("runtimeGate is invalid");
  }
  return {
    globalEnabled: requireBoolean("runtimeGate.globalEnabled", input.globalEnabled),
    writeKnowledgeBase: requireBoolean("runtimeGate.writeKnowledgeBase", input.writeKnowledgeBase),
    disabledGroupIds: normalizeReferenceList("runtimeGate.disabledGroupIds", input.disabledGroupIds, true),
  };
}

function normalizeCompletePublicationExecutionInput(input: CompletePublicationExecutionInput) {
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
    expectedSubjectRevision: requirePositiveInteger(
      "expectedSubjectRevision",
      input.expectedSubjectRevision,
    ),
    remoteNodeToken: requireReference("remoteNodeToken", input.remoteNodeToken),
    remoteDocumentToken: requireReference("remoteDocumentToken", input.remoteDocumentToken),
    remoteDocumentType: requireRemoteDocumentType(input.remoteDocumentType),
    ...(input.remoteDocumentVersion === undefined
      ? {}
      : { remoteDocumentVersion: requirePositiveInteger(
          "remoteDocumentVersion",
          input.remoteDocumentVersion,
        ) }),
    contentHash: requireSha256("contentHash", input.contentHash),
    permissionCheckSummary: requireBoundedString(
      "permissionCheckSummary",
      input.permissionCheckSummary,
      512,
    ),
    operationKey: requireReference("operationKey", input.operationKey),
    at: requireDate(input.at),
  };
}

function requireRemoteDocumentType(value: unknown): "doc" | "docx" | "sheet" | "bitable" | "wiki" {
  if (
    value === "doc" ||
    value === "docx" ||
    value === "sheet" ||
    value === "bitable" ||
    value === "wiki"
  ) return value;
  throw new Error("remoteDocumentType is invalid");
}

function normalizeGovernanceDispositionInput(
  input: ApplyActionProposalGovernanceDispositionInput,
) {
  if (!(input.action === "request_revision" || input.action === "reject")) {
    throw new Error("governance disposition action is invalid");
  }
  return {
    proposalId: requireReference("proposalId", input.proposalId),
    expectedProposalVersion: requirePositiveInteger(
      "expectedProposalVersion",
      input.expectedProposalVersion,
    ),
    expectedSubjectRevision: requirePositiveInteger(
      "expectedSubjectRevision",
      input.expectedSubjectRevision,
    ),
    expectedSubjectVersion: requirePositiveInteger(
      "expectedSubjectVersion",
      input.expectedSubjectVersion,
    ),
    action: input.action,
    reason: requireBoundedReason(input.reason),
    operationKey: requireReference("operationKey", input.operationKey),
    operator: requireReference("operator", input.operator),
    at: requireDate(input.at),
  };
}

function normalizeCancelStaleInput(input: CancelStaleActionProposalsInput) {
  return {
    draftId: requireReference("draftId", input.draftId),
    currentRevision: requirePositiveInteger("currentRevision", input.currentRevision),
    currentDraftVersion: requirePositiveInteger("currentDraftVersion", input.currentDraftVersion),
    operationKey: requireReference("operationKey", input.operationKey),
    at: requireDate(input.at),
  };
}

async function withTransaction<T>(
  dataSource: PostgresKnowledgeDraftDataSource,
  operation: (client: KnowledgeDraftTransactionClient) => Promise<T>,
): Promise<T> {
  const client = await dataSource.connect();
  try {
    await client.query("BEGIN");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function lockOperation(client: KnowledgeDraftTransactionClient, key: string): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [key]);
}

function operationFingerprint(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value, (_key, item) => item instanceof Date ? item.toISOString() : item))
    .digest("hex");
}

function derivedOperationKey(prefix: string, value: unknown): string {
  return `${prefix}:${operationFingerprint(value)}`;
}

function normalizeStatusFilter(value: ActionProposalStatus[] | undefined) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length < 1 || value.length > ACTION_PROPOSAL_STATUSES.length) {
    throw new Error("statuses is invalid");
  }
  const normalized = [...new Set(value)];
  if (normalized.some((item) => !ACTION_PROPOSAL_STATUSES.includes(item))) {
    throw new Error("statuses is invalid");
  }
  return normalized.sort();
}

function normalizeRiskLevels(value: KnowledgeDraftRiskLevel[]): KnowledgeDraftRiskLevel[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > KNOWLEDGE_DRAFT_RISK_LEVELS.length) {
    throw new Error("allowedRiskLevels is invalid");
  }
  const normalized = [...new Set(value)];
  if (normalized.some((item) => !KNOWLEDGE_DRAFT_RISK_LEVELS.includes(item))) {
    throw new Error("allowedRiskLevels is invalid");
  }
  return normalized.sort();
}

function normalizeReferenceList(name: string, value: string[], allowEmpty: boolean): string[] {
  if (!Array.isArray(value) || value.length > 100 || (!allowEmpty && value.length < 1)) {
    throw new Error(`${name} is invalid`);
  }
  const normalized = value.map((item) => requireReference(name, item));
  if (new Set(normalized).size !== normalized.length) throw new Error(`${name} is invalid`);
  return normalized.sort();
}

function requireRoleType(value: unknown): ActionRoleGrantType {
  if (!ACTION_ROLE_GRANT_TYPES.includes(value as ActionRoleGrantType)) {
    throw new Error("roleType is invalid");
  }
  return value as ActionRoleGrantType;
}

function requireApprovalAction(value: unknown): "approve" | "request_revision" | "reject" {
  if (!(value === "approve" || value === "request_revision" || value === "reject")) {
    throw new Error("action is invalid");
  }
  return value;
}

function requireReference(name: string, value: unknown): string {
  return requireBoundedString(name, value, KNOWLEDGE_DRAFT_REFERENCE_MAX_CHARS);
}

function requireBoundedString(name: string, value: unknown, max: number): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  const normalized = value.trim();
  if ([...normalized].length < 1 || [...normalized].length > max) {
    throw new Error(`${name} is invalid`);
  }
  return normalized;
}

function requireSha256(name: string, value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function requirePositiveInteger(name: string, value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new Error(`${name} is invalid`);
  return Number(value);
}

function requireNonnegativeInteger(name: string, value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`${name} is invalid`);
  return Number(value);
}

function requireLimit(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > 100) {
    throw new Error("limit is invalid");
  }
  return Number(value);
}

function requireBoolean(name: string, value: unknown): boolean {
  if (typeof value !== "boolean") throw new Error(`${name} is invalid`);
  return value;
}

function requireBoundedReason(value: unknown): string {
  if (typeof value !== "string") throw new Error("reason must be a string");
  const normalized = value.trim();
  if ([...normalized].length < 1 || [...normalized].length > 2_000) {
    throw new Error("reason length is invalid");
  }
  return normalized;
}

function requireDate(value: unknown): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error("date is invalid");
  return new Date(value);
}

function requireDatabaseValue<T>(value: T | null): T {
  if (value === null) throw new ActionProposalPersistenceConflictError();
  return value;
}
