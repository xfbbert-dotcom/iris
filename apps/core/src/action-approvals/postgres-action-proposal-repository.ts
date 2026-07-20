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
import { validateCurrentKnowledgeDraftEvidence } from "../knowledge-governance/postgres-knowledge-draft-evidence.js";
import type {
  KnowledgeDraftTransactionClient,
  PostgresKnowledgeDraftDataSource,
} from "../knowledge-governance/postgres-knowledge-draft-repository.js";

import {
  ACTION_PROPOSAL_STATUSES,
  ACTION_ROLE_GRANT_TYPES,
  buildApprovalRequirementSnapshot,
  type ActionApprovalRequirementKind,
  type ActionApprovalRoleRefType,
  type ActionProposal,
  type ActionProposalStatus,
  type ActionRoleGrantType,
} from "./action-proposal.js";
import type {
  ActionApproval,
  ActionApprovalRequirement,
  ActionProposalContext,
  ActionProposalEvent,
  ActionProposalMutationResult,
  ActionProposalRepository,
  ActionProposalStatusCounts,
  ActionRoleGrant,
  ApplyActionProposalActionInput,
  ApplyActionProposalActionResult,
  CancelStaleActionProposalsInput,
  CancelStaleActionProposalsResult,
  CreateActionProposalInput,
  PolicyMutationResult,
  PublicationTargetPolicy,
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
  version: string | number;
};

type DraftRevisionRow = {
  id: string;
  source_group_id: string | null;
  status: string;
  current_revision_number: string | number;
  version: string | number;
  risk_level: KnowledgeDraftRiskLevel;
  reviewer_type: "feishu_user" | "text_label" | "admin_role" | null;
  reviewer_ref: string | null;
  suggested_space_id: string | null;
  suggested_parent_node_token: string | null;
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
    getProposal(id) {
      return loadProposalContext(dataSource, requireReference("id", id));
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
  const fingerprint = operationFingerprint({ operation: "apply_action_proposal_action", ...normalized });
  return withTransaction(dataSource, async (client) => {
    await lockOperation(client, normalized.operationKey);
    if (normalized.action === "approve") {
      const replay = await client.query<ApprovalRow>(
        `${approvalSelect()} WHERE operation_key = $1 OR callback_event_id = $2
         ORDER BY CASE WHEN operation_key = $1 THEN 0 ELSE 1 END LIMIT 1`,
        [normalized.operationKey, normalized.callbackEventId],
      );
      if (replay.rows[0] !== undefined) {
        if (
          replay.rows[0].operation_key !== normalized.operationKey ||
          replay.rows[0].operation_fingerprint !== fingerprint
        ) throw new ActionProposalOperationConflictError();
        const proposal = await requireProposal(client, replay.rows[0].proposal_id);
        const draft = await requireDraftState(client, proposal.subjectId);
        return {
          outcome: "already_applied",
          action: normalized.action,
          proposal,
          draftStatus: draft.status,
          draftVersion: draft.version,
        };
      }
    } else {
      const replay = await client.query<{
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
        const proposal = await requireProposal(client, normalized.proposalId);
        if (replay.rows[0].draft_id !== proposal.subjectId) {
          throw new ActionProposalOperationConflictError();
        }
        const draft = await requireDraftState(client, proposal.subjectId);
        return {
          outcome: "already_applied",
          action: normalized.action,
          proposal,
          draftStatus: draft.status,
          draftVersion: Number(replay.rows[0].to_version),
        };
      }
      const callbackReplay = await client.query<{ operation_key: string }>(
        `SELECT operation_key FROM action_approval_presentation_events
         WHERE callback_event_id = $1`,
        [normalized.callbackEventId],
      );
      if (callbackReplay.rows[0] !== undefined) throw new ActionProposalOperationConflictError();
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

async function lockProposal(
  client: KnowledgeDraftTransactionClient,
  id: string,
): Promise<ProposalRow> {
  const result = await client.query<ProposalRow>(`${proposalSelect()} WHERE id = $1 FOR UPDATE`, [id]);
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
    `SELECT id, proposal_id, requirement_id, proposal_version, recipient_open_id, state, version
     FROM action_approval_presentations WHERE id = $1 FOR UPDATE`,
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
  client: KnowledgeDraftTransactionClient,
  id: string,
): Promise<{ status: KnowledgeDraftStatus; version: number }> {
  const result = await client.query<{ status: string; version: string | number }>(
    "SELECT status, version FROM knowledge_drafts WHERE id = $1",
    [id],
  );
  const row = result.rows[0];
  if (row === undefined || !KNOWLEDGE_DRAFT_STATUSES.includes(row.status as KnowledgeDraftStatus)) {
    throw new ActionProposalPersistenceConflictError();
  }
  return { status: row.status as KnowledgeDraftStatus, version: Number(row.version) };
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
      await client.query(
        `INSERT INTO action_approval_requirements (
          id, proposal_id, requirement_kind, role_ref_type, role_ref,
          target_policy_id, target_policy_version, state,
          satisfied_actor_open_id, satisfied_source_type, satisfied_source_id,
          version, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 1, $12, $12)`,
        [
          randomUUID(),
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
            draft.version, revision.risk_level, revision.reviewer_type, revision.reviewer_ref,
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
  const result = await client.query<EvidenceRow>(
    `SELECT evidence_type, reference_id, source_group_id, entity_version, source_updated_at
     FROM knowledge_draft_revision_evidence
     WHERE draft_id = $1 AND revision_number = $2
     ORDER BY evidence_type ASC, reference_id ASC`,
    [draft.id, Number(draft.current_revision_number)],
  );
  await validateCurrentKnowledgeDraftEvidence({
    queryable: client,
    sourceGroupId: draft.source_group_id ?? undefined,
    evidence: result.rows.map(mapEvidence),
  });
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

function actionEventSelect(): string {
  return `SELECT id, proposal_id, event_type, actor_open_id, from_version, to_version,
                 reason_code, created_at
          FROM action_events`;
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
    sourcePresentationId: requireReference("sourcePresentationId", input.sourcePresentationId),
    callbackEventId: requireReference("callbackEventId", input.callbackEventId),
    actorOpenId: requireReference("actorOpenId", input.actorOpenId),
    action,
    ...(reason === undefined ? {} : { reason }),
    ...(action === "reject" ? { rejectionConfirmed: true as const } : {}),
    operationKey: requireReference("operationKey", input.operationKey),
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
