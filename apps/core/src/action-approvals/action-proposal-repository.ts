import type {
  KnowledgeDraftEvidenceInvalidReason,
} from "../knowledge-governance/knowledge-draft-repository.js";
import type {
  KnowledgeDraftRiskLevel,
  KnowledgeDraftStatus,
} from "../knowledge-governance/knowledge-draft.js";
import type {
  FeishuTaskTargetPolicy,
  FormalTaskRiskLevel,
} from "../formal-tasks/formal-task-repository.js";

import type {
  ActionApprovalRequirementKind,
  ActionProposalActionType,
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

type ActionProposalContextBase = {
  requirements: ActionApprovalRequirement[];
  approvals: ActionApproval[];
};

export type ActionProposalContext =
  | (ActionProposalContextBase & {
      proposal: Extract<ActionProposal, { subjectType: "knowledge_draft" }>;
      formalTask?: never;
      managedTarget?: {
        managedPageId: string;
        documentSourceId: string;
        targetSourceUri: string;
      };
    })
  | (ActionProposalContextBase & {
      proposal: Extract<ActionProposal, { subjectType: "formal_task_draft" }>;
      managedTarget?: never;
      formalTask: {
        sourceGroupId: string;
        title: string;
        description: string;
        assigneeOpenId: string;
        dueAt?: Date;
        reminderMinutes?: 0 | 30 | 60 | 1440;
        taskSpecHash: string;
        groupConfirmationPresentationId: string;
      };
    });

export type KnowledgeActionProposalContext = Extract<
  ActionProposalContext,
  { proposal: { subjectType: "knowledge_draft" } }
>;

export type FormalTaskActionProposalContext = Extract<
  ActionProposalContext,
  { proposal: { subjectType: "formal_task_draft" } }
>;

export type ActionReviewContext = {
  proposalId: string;
  proposalVersion: number;
  actionType: ActionProposalActionType;
  actionTargetFingerprint: string;
  draftId: string;
  subjectRevision: number;
  subjectVersion: number;
  title: string;
  content: string;
  contentHash: string;
  riskLevel: KnowledgeDraftRiskLevel;
  targetPolicyId: string;
  targetPolicyVersion: number;
  targetDisplayName: string;
  managedTarget?: {
    managedPageId: string;
    managedPageVersion: number;
    documentSourceId: string;
    targetSourceUri: string;
    targetSnapshotId: string;
    targetSnapshotHash: string;
    conflictCandidateId: string;
    conflictCandidateVersion: number;
    remoteDocumentToken: string;
    managedBodyBlockId: string;
    expectedRemoteRevisionId: string;
    currentBodyContentHash: string;
    authorizationGroupId: string;
  };
  requirements: Array<{
    kind: ActionApprovalRequirementKind;
    state: "pending" | "satisfied" | "invalidated";
  }>;
};

export type RecordActionReviewAttestationInput = {
  proposalId: string;
  actorOpenId: string;
  expectedProposalVersion: number;
  expectedSubjectRevision: number;
  expectedSubjectVersion: number;
  expectedContentHash: string;
  expectedActionTargetFingerprint: string;
  sessionIdHash: string;
  operationKey: string;
  at: Date;
};

export type CurrentActionReviewAttestationInput = Pick<
  RecordActionReviewAttestationInput,
  | "proposalId"
  | "actorOpenId"
  | "expectedProposalVersion"
  | "expectedSubjectRevision"
  | "expectedSubjectVersion"
  | "expectedContentHash"
  | "expectedActionTargetFingerprint"
>;

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
  context: KnowledgeActionProposalContext;
  requirement: ActionApprovalRequirement;
  policy: PublicationTargetPolicy;
  presentation: ActionApprovalPresentation;
  sourceGroupId?: string;
};

export type ActionApprovalOutboxStatusCounts = {
  pending: number;
  processing: number;
  external_attempting: number;
  sent: number;
  failed: number;
  outcome_unknown: number;
  terminalFailed: number;
};

export type PublicationExecutionState =
  | "pending"
  | "executing"
  | "succeeded"
  | "failed"
  | "outcome_unknown"
  | "reconciliation_required";

export type PublicationExecution = {
  id: string;
  proposalId: string;
  attemptNumber: number;
  state: PublicationExecutionState;
  requestFingerprint: string;
  provider: "feishu_wiki";
  responseClassification?: string;
  remoteNodeToken?: string;
  remoteDocumentToken?: string;
  version: number;
  retryAt?: Date;
  createdAt: Date;
  updatedAt: Date;
};

export type ClaimedPublicationDraft = {
  id: string;
  sourceGroupId?: string;
  revisionNumber: number;
  version: number;
  title: string;
  content: string;
  riskLevel: KnowledgeDraftRiskLevel;
  suggestedPublication?: { spaceId?: string; parentNodeToken?: string };
};

export type KnowledgePublication = {
  id: string;
  proposalId: string;
  executionId: string;
  draftId: string;
  revisionNumber: number;
  draftVersion: number;
  targetPolicyId: string;
  targetPolicyVersion: number;
  spaceId: string;
  remoteNodeToken: string;
  remoteDocumentToken: string;
  remoteDocumentType: string;
  remoteDocumentVersion?: number;
  contentHash: string;
  permissionCheckSummary: string;
  operationKey: string;
  publishedAt: Date;
  createdAt: Date;
};

export type ActionProposalDraftCandidate = {
  id: string;
  actionType: "publish_knowledge_draft" | "update_knowledge_publication";
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

export type FormalTaskActionProposalDraftCandidate = {
  id: string;
  actionType: "create_feishu_task";
  sourceGroupId: string;
  currentRevision: number;
  version: number;
  riskLevel: FormalTaskRiskLevel;
  assigneeOpenId: string;
  dueAt?: Date;
  reminderMinutes?: 0 | 30 | 60 | 1440;
  taskSpecHash: string;
  targetPolicyId: string;
  targetPolicyVersion: number;
  groupConfirmationPresentationId: string;
  evidenceState:
    | { status: "current" }
    | { status: "invalidated"; reason: KnowledgeDraftEvidenceInvalidReason };
  hasCurrentGroupConfirmation: boolean;
  updatedAt: Date;
};

export type ActionProposalPlanningCandidate =
  | ActionProposalDraftCandidate
  | FormalTaskActionProposalDraftCandidate;

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
  actionType?: ActionProposalActionType;
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
  expectedTargetPolicyVersion: number;
  sourcePresentationId: string;
  callbackEventId: string;
  actorOpenId: string;
  action: "approve" | "request_revision" | "reject";
  requireReviewAttestation: boolean;
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

export type ApplyActionProposalGovernanceDispositionInput = {
  proposalId: string;
  expectedProposalVersion: number;
  expectedSubjectRevision: number;
  expectedSubjectVersion: number;
  action: "request_revision" | "reject";
  reason: string;
  operationKey: string;
  operator: string;
  at: Date;
};

export type ApplyActionProposalGovernanceDispositionResult = {
  outcome: "applied" | "already_applied";
  action: ApplyActionProposalGovernanceDispositionInput["action"];
  proposal: ActionProposal;
  draftStatus: KnowledgeDraftStatus;
  draftVersion: number;
};

export type ClaimApprovedPublicationExecutionInput = {
  proposalId: string;
  expectedProposalVersion: number;
  runtimeGate: {
    globalEnabled: boolean;
    writeKnowledgeBase: boolean;
    disabledGroupIds: string[];
  };
  workerId: string;
  operationKey: string;
  at: Date;
};

export type ClaimApprovedPublicationExecutionResult = {
  outcome: "applied" | "already_applied";
  proposal: ActionProposal;
  execution: PublicationExecution;
  draft: ClaimedPublicationDraft;
  policy: PublicationTargetPolicy;
};

export type CompletePublicationExecutionInput = {
  proposalId: string;
  executionId: string;
  expectedProposalVersion: number;
  expectedExecutionVersion: number;
  expectedDraftVersion: number;
  expectedSubjectRevision: number;
  remoteNodeToken: string;
  remoteDocumentToken: string;
  remoteDocumentType: "doc" | "docx" | "sheet" | "bitable" | "wiki";
  remoteDocumentVersion?: number;
  contentHash: string;
  permissionCheckSummary: string;
  operationKey: string;
  at: Date;
};

export type CompletePublicationExecutionResult = {
  outcome: "applied" | "already_applied";
  proposal: ActionProposal;
  execution: PublicationExecution;
  draftStatus: KnowledgeDraftStatus;
  draftVersion: number;
  publication: KnowledgePublication;
};

export type FailPublicationExecutionInput = {
  proposalId: string;
  executionId: string;
  expectedProposalVersion: number;
  expectedExecutionVersion: number;
  classification: "failed" | "reconciliation_required";
  responseClassification: string;
  operationKey: string;
  at: Date;
};

export type FailPublicationExecutionResult = {
  outcome: "applied" | "already_applied";
  proposal: ActionProposal;
  execution: PublicationExecution;
};

export type ActionApprovalReplayInspection = {
  result: ApplyActionProposalActionResult;
  sourceGroupId?: string;
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
  action: "approve" | "request_revision" | "reject";
  requireReviewAttestation: boolean;
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
  applyGovernanceDisposition(
    input: ApplyActionProposalGovernanceDispositionInput,
  ): Promise<ApplyActionProposalGovernanceDispositionResult>;
  claimApprovedPublicationExecution(
    input: ClaimApprovedPublicationExecutionInput,
  ): Promise<ClaimApprovedPublicationExecutionResult>;
  completePublicationExecution(
    input: CompletePublicationExecutionInput,
  ): Promise<CompletePublicationExecutionResult>;
  failPublicationExecution(
    input: FailPublicationExecutionInput,
  ): Promise<FailPublicationExecutionResult>;
  inspectApprovalActionReplay(
    input: ApplyActionProposalActionInput,
  ): Promise<ActionApprovalReplayInspection | undefined>;
  preflightApprovalAction(
    input: PreflightActionApprovalInput,
  ): Promise<{ sourceGroupId?: string }>;
  getAuthorizedReviewContext(input: {
    proposalId: string;
    actorOpenId: string;
  }): Promise<ActionReviewContext | undefined>;
  recordReviewAttestation(
    input: RecordActionReviewAttestationInput,
  ): Promise<{ outcome: "applied" | "already_applied" }>;
  hasCurrentReviewAttestation(input: CurrentActionReviewAttestationInput): Promise<boolean>;
  hasActionReviewMigration?(): Promise<boolean>;
  listApprovalPresentations(input: {
    proposalId: string;
    afterId?: string;
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
  listEligibleFormalTaskDrafts?(input: {
    groupIds: string[];
    limit: number;
  }): Promise<FormalTaskActionProposalDraftCandidate[]>;
  listFeishuTaskTargetPolicies?(input: {
    enabled?: boolean;
    limit: number;
  }): Promise<FeishuTaskTargetPolicy[]>;
  cancelStaleFormalTaskProposals?(
    input: CancelStaleActionProposalsInput,
  ): Promise<CancelStaleActionProposalsResult>;
  listEvents(id: string): Promise<ActionProposalEvent[]>;
  listProposals(input: {
    statuses?: ActionProposalStatus[];
    actionTypes?: ActionProposalActionType[];
    subjectId?: string;
    authorizationGroupIds?: string[];
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
