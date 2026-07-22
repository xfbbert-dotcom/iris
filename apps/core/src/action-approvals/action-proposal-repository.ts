import type {
  KnowledgeDraftEvidenceInvalidReason,
} from "../knowledge-governance/knowledge-draft-repository.js";
import type {
  KnowledgeDraftRiskLevel,
  KnowledgeDraftStatus,
} from "../knowledge-governance/knowledge-draft.js";

import type {
  ActionApprovalRequirementKind,
  ActionProposal,
  ActionProposalStatus,
  ActionRoleGrantType,
} from "./action-proposal.js";

export type ActionProposalStatusCounts = Record<ActionProposalStatus, number>;

export type PublicationTargetPolicy = {
  id: string;
  spaceId: string;
  parentNodeToken?: string;
  displayName: string;
  allowedGroupIds: string[];
  allowedRiskLevels: KnowledgeDraftRiskLevel[];
  enabled: boolean;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};

export type ActionRoleGrant = {
  roleType: ActionRoleGrantType;
  actorOpenId: string;
  enabled: boolean;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};

export type ActionApprovalRequirement = {
  id: string;
  proposalId: string;
  kind: ActionApprovalRequirementKind;
  roleRefType: "source_group" | "feishu_user" | "unassigned";
  roleRef?: string;
  targetPolicyId: string;
  targetPolicyVersion: number;
  state: "pending" | "satisfied" | "invalidated";
  satisfiedActorOpenId?: string;
  satisfiedSourceType?: "group_confirmation" | "action_approval";
  satisfiedSourceId?: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};

export type ActionApproval = {
  id: string;
  proposalId: string;
  requirementId: string;
  actorOpenId: string;
  sourcePresentationId: string;
  callbackEventId: string;
  subjectRevision: number;
  subjectVersion: number;
  operationKey: string;
  createdAt: Date;
};

export type ActionProposalEvent = {
  id: string;
  proposalId: string;
  eventType:
    | "created"
    | "approval_recorded"
    | "requirements_satisfied"
    | "revision_requested"
    | "rejected"
    | "approval_invalidated"
    | "cancelled"
    | "expired"
    | "execution_started"
    | "execution_succeeded"
    | "execution_failed"
    | "execution_reconciliation_required";
  actorOpenId?: string;
  fromVersion?: number;
  toVersion: number;
  reasonCode?: string;
  createdAt: Date;
};

export type ActionProposalContext = {
  proposal: ActionProposal;
  requirements: ActionApprovalRequirement[];
  approvals: ActionApproval[];
};

export type ActionApprovalPresentationState =
  | "pending_send"
  | "active"
  | "superseded"
  | "closed"
  | "send_failed";

export type ActionApprovalPresentation = {
  id: string;
  proposalId: string;
  requirementId: string;
  proposalVersion: number;
  recipientOpenId: string;
  state: ActionApprovalPresentationState;
  messageId?: string;
  operationKey: string;
  version: number;
  createdAt: Date;
  activatedAt?: Date;
  closedAt?: Date;
};

export type ActionApprovalSendClaim = {
  presentation: ActionApprovalPresentation;
  workerId: string;
  leaseUntil: Date;
  attempts: number;
};

export type ActionApprovalDeliveryContext = {
  context: ActionProposalContext;
  requirement: ActionApprovalRequirement;
  policy: PublicationTargetPolicy;
  presentation: ActionApprovalPresentation;
};

export type ActionApprovalOutboxStatusCounts = {
  pending: number;
  processing: number;
  external_attempting: number;
  sent: number;
  failed: number;
  outcome_unknown: number;
};

export type ActionProposalDraftCandidate = {
  id: string;
  sourceGroupId?: string;
  currentRevision: number;
  version: number;
  riskLevel: KnowledgeDraftRiskLevel;
  reviewer?: { type: "feishu_user" | "text_label" | "admin_role"; ref: string };
  suggestedPublication?: { spaceId?: string; parentNodeToken?: string };
  evidenceState:
    | { status: "current" }
    | { status: "invalidated"; reason: KnowledgeDraftEvidenceInvalidReason };
  hasCurrentGroupConfirmation: boolean;
  updatedAt: Date;
};

export type UpsertPublicationTargetPolicyInput = {
  id: string;
  spaceId: string;
  parentNodeToken?: string;
  displayName: string;
  allowedGroupIds: string[];
  allowedRiskLevels: KnowledgeDraftRiskLevel[];
  enabled: boolean;
  expectedVersion: number;
  operationKey: string;
  operator: string;
  at: Date;
};

export type UpsertActionRoleGrantInput = {
  roleType: ActionRoleGrantType;
  actorOpenId: string;
  enabled: boolean;
  expectedVersion: number;
  operationKey: string;
  operator: string;
  at: Date;
};

export type CreateActionProposalInput = {
  proposalId: string;
  draftId: string;
  expectedRevision: number;
  expectedDraftVersion: number;
  targetPolicyId: string;
  expectedTargetPolicyVersion: number;
  operationKey: string;
  at: Date;
};

export type PolicyMutationResult = {
  outcome: "applied" | "already_applied";
  policy: PublicationTargetPolicy;
};

export type RoleGrantMutationResult = {
  outcome: "applied" | "already_applied";
  grant: ActionRoleGrant;
};

export type ActionProposalMutationResult = {
  outcome: "applied" | "already_applied";
  proposal: ActionProposal;
};

export type CancelStaleActionProposalsInput = {
  draftId: string;
  currentRevision: number;
  currentDraftVersion: number;
  operationKey: string;
  at: Date;
};

export type CancelStaleActionProposalsResult = {
  outcome: "applied" | "already_applied";
  cancelledProposalIds: string[];
  draftVersion: number;
};

export type ApplyActionProposalActionInput = {
  proposalId: string;
  requirementId: string;
  expectedProposalVersion: number;
  expectedSubjectRevision: number;
  expectedSubjectVersion: number;
  sourcePresentationId: string;
  callbackEventId: string;
  actorOpenId: string;
  action: "approve" | "request_revision" | "reject";
  reason?: string;
  rejectionConfirmed?: boolean;
  operationKey: string;
  at: Date;
};

export type ApplyActionProposalActionResult = {
  outcome: "applied" | "already_applied";
  action: ApplyActionProposalActionInput["action"];
  proposal: ActionProposal;
  draftStatus: KnowledgeDraftStatus;
  draftVersion: number;
};

export type PreflightActionApprovalInput = {
  proposalId: string;
  requirementId: string;
  expectedProposalVersion: number;
  expectedSubjectRevision: number;
  expectedSubjectVersion: number;
  expectedTargetPolicyVersion: number;
  sourcePresentationId: string;
  actorOpenId: string;
};

export interface ActionProposalRepository {
  upsertTargetPolicy(input: UpsertPublicationTargetPolicyInput): Promise<PolicyMutationResult>;
  upsertRoleGrant(input: UpsertActionRoleGrantInput): Promise<RoleGrantMutationResult>;
  actorHasCurrentRole(input: {
    roleType: ActionRoleGrantType;
    actorOpenId: string;
  }): Promise<boolean>;
  createProposal(input: CreateActionProposalInput): Promise<ActionProposalMutationResult>;
  cancelStaleProposals(
    input: CancelStaleActionProposalsInput,
  ): Promise<CancelStaleActionProposalsResult>;
  applyApprovalAction(
    input: ApplyActionProposalActionInput,
  ): Promise<ApplyActionProposalActionResult>;
  preflightApprovalAction(
    input: PreflightActionApprovalInput,
  ): Promise<{ sourceGroupId?: string }>;
  listApprovalPresentations(input: {
    proposalId: string;
    limit: number;
  }): Promise<ActionApprovalPresentation[]>;
  claimApprovalPresentationSend(input: {
    workerId: string;
    leaseUntil: Date;
    at: Date;
  }): Promise<ActionApprovalSendClaim | undefined>;
  getApprovalDeliveryContext(id: string): Promise<ActionApprovalDeliveryContext | undefined>;
  beginApprovalExternalAttempt(input: {
    presentationId: string;
    workerId: string;
    at: Date;
  }): Promise<void>;
  failApprovalPresentationPreparation(input: {
    presentationId: string;
    workerId: string;
    errorCode: string;
    at: Date;
  }): Promise<void>;
  completeApprovalPresentationSend(input: {
    presentationId: string;
    workerId: string;
    messageId: string;
    at: Date;
  }): Promise<void>;
  failApprovalPresentationSend(input: {
    presentationId: string;
    workerId: string;
    classification: "retryable" | "permanent" | "outcome_unknown";
    errorCode: string;
    retryAt?: Date;
    at: Date;
  }): Promise<void>;
  getApprovalOutboxStatusCounts(): Promise<ActionApprovalOutboxStatusCounts>;
  getProposal(id: string): Promise<ActionProposalContext | undefined>;
  listEligibleDrafts(input: {
    groupIds?: string[];
    limit: number;
  }): Promise<ActionProposalDraftCandidate[]>;
  listEvents(id: string): Promise<ActionProposalEvent[]>;
  listProposals(input: {
    statuses?: ActionProposalStatus[];
    subjectId?: string;
    limit: number;
  }): Promise<ActionProposal[]>;
  getStatusCounts(): Promise<ActionProposalStatusCounts>;
  getTargetPolicy(id: string): Promise<PublicationTargetPolicy | undefined>;
  listTargetPolicies(input: { enabled?: boolean; limit: number }): Promise<PublicationTargetPolicy[]>;
  listRoleGrants(input: {
    roleType?: ActionRoleGrantType;
    enabled?: boolean;
    limit: number;
  }): Promise<ActionRoleGrant[]>;
}
