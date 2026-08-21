import type {
  ManagedKnowledgePage,
  ManagedKnowledgePageState,
  ManagedKnowledgeUpdateExecution,
  ManagedKnowledgeUpdateExecutionState,
  ManagedKnowledgeUpdateTarget,
  ManagedSnapshotObservation,
} from "./managed-knowledge-page.js";
import type { ActionProposal } from "./action-proposal.js";
import type { KnowledgeDraftRiskLevel } from "../knowledge-governance/knowledge-draft.js";

export type RegisterManagedPublicationInput = {
  id: string;
  originKnowledgePublicationId: string;
  targetPolicyId: string;
  targetPolicyVersion: number;
  authorizationGroupId: string;
  remoteNodeToken: string;
  remoteDocumentToken: string;
  managedBodyBlockId: string;
  currentRemoteRevisionId: string;
  currentBodyContentHash: string;
  operationKey: string;
  actor: string;
  at: Date;
};

export type EligibleManagedPageForConflictInput = {
  documentSourceId: string;
  authorizationGroupId: string;
};

export type FindManagedPageByRemoteIdentityInput = {
  remoteWikiNodeToken?: string;
  remoteDocumentToken?: string;
};

export type LinkManagedPageSourceInput = {
  managedPageId: string;
  expectedVersion: number;
  documentSourceId: string;
  operationKey: string;
  actor: string;
  at: Date;
};

export type RecordManagedSnapshotObservationInput = Omit<ManagedSnapshotObservation, "createdAt"> & {
  operationKey: string;
  at: Date;
};

export type BindManagedUpdateTargetInput = Omit<ManagedKnowledgeUpdateTarget, "createdAt"> & {
  operationKey: string;
  at: Date;
};

export type ClaimManagedUpdateInput = {
  proposalId: string;
  expectedProposalVersion: number;
  runtimeGate: {
    deploymentEnabled: boolean;
    globalEnabled: boolean;
    writeKnowledgeBase: boolean;
    updateManagedKnowledge: boolean;
    disabledGroupIds: string[];
    allowedGroupIds: string[];
  };
  operationKey: string;
  workerId: string;
  at: Date;
};

export type RecordManagedRemoteOutcomeInput = {
  executionId: string;
  expectedExecutionVersion: number;
  expectedManagedPageVersion?: number;
  classification: "preflight_failed" | "outcome_unknown" | "remote_applied" | "failed" | "reconciliation_required";
  responseClassification?: string;
  responseRevisionId?: string;
  reconciliationReasonCode?: string;
  pageDisposition: "active" | "resync_required" | "reconciliation_required" | "blocked" | "retired";
  verifiedUnchangedRemote?: {
    remoteDocumentToken: string;
    managedBodyBlockId: string;
    remoteRevisionId: string;
    bodyContentHash: string;
  };
  operationKey: string;
  actor: string;
  at: Date;
};
export type MarkManagedRemoteRequestDispatchedInput = {
  executionId: string;
  expectedExecutionVersion: number;
  operationKey: string;
  actor: string;
  at: Date;
};

export type ClaimManagedRemoteRetryInput = MarkManagedRemoteRequestDispatchedInput & {
  staleDispatchedBefore: Date;
};

export type CompleteManagedResyncInput = {
  executionId: string;
  expectedExecutionVersion: number;
  expectedManagedPageVersion: number;
  observationId: string;
  operationKey: string;
  actor: string;
  at: Date;
};

export type ManagedResyncReadyExecution = {
  executionId: string;
  executionVersion: number;
  managedPageVersion: number;
  observationId: string;
};

export type ManagedPageMutationResult = {
  outcome: "applied" | "already_applied";
  page: ManagedKnowledgePage;
};
export type ManagedSnapshotObservationResult = {
  outcome: "applied" | "already_applied";
  observation: ManagedSnapshotObservation;
};
export type ManagedTargetMutationResult = {
  outcome: "applied" | "already_applied";
  target: ManagedKnowledgeUpdateTarget;
};
export type ClaimedManagedKnowledgeUpdate = {
  outcome: "applied" | "already_applied";
  proposal: ActionProposal;
  draft: {
    id: string;
    sourceGroupId: string;
    revisionNumber: number;
    version: number;
    content: string;
    riskLevel: KnowledgeDraftRiskLevel;
  };
  page: ManagedKnowledgePage;
  target: ManagedKnowledgeUpdateTarget;
  execution: ManagedKnowledgeUpdateExecution;
};

export type TerminalManagedKnowledgeUpdateClaim = {
  outcome: "terminal";
  proposalId: string;
  proposalVersion: number;
  code: "stale_target" | "competing_execution" | "approval_chain_invalid";
};

export type ManagedKnowledgeUpdateClaimResult =
  | ClaimedManagedKnowledgeUpdate
  | TerminalManagedKnowledgeUpdateClaim;
export type ManagedKnowledgeUpdateMetadata = {
  managedTarget: {
    id: string;
    expectedRevision: string;
    currentBodyHash: string;
    proposedBodyHash: string;
    state: ManagedKnowledgePageState;
  };
  page: {
    id: string;
    sourceId?: string;
    state: ManagedKnowledgePageState;
    version: number;
    currentRevision?: string;
    safeWikiUrl: string;
  };
  executions: Array<{
    id: string;
    state: ManagedKnowledgeUpdateExecutionState;
    version: number;
    requestFingerprint: string;
    reasonCode?: string;
    createdAt: Date;
    updatedAt: Date;
    events: Array<{
      type: string;
      fromVersion?: number;
      toVersion: number;
      reasonCode?: string;
      at: Date;
    }>;
  }>;
};
export type ManagedKnowledgeReconciliationRequest = {
  executionId: string;
  expectedExecutionVersion: number;
  expectedManagedPageVersion: number;
  operationKey: string;
  operator: string;
  at: Date;
};
export type ManagedKnowledgeReconciliationRequestResult = {
  outcome: "applied" | "already_applied";
  claim: ClaimedManagedKnowledgeUpdate;
  acknowledgement: {
    executionId: string;
    state: "reconciliation_required";
    version: number;
    reasonCode: "operator_requested";
  };
};
export type ManagedExecutionMutationResult = {
  outcome: "applied" | "already_applied";
  page: ManagedKnowledgePage;
  execution: ManagedKnowledgeUpdateExecution;
};

export interface ManagedKnowledgePageRepository {
  registerPublication(input: RegisterManagedPublicationInput): Promise<ManagedPageMutationResult>;
  findByRemoteIdentity(input: FindManagedPageByRemoteIdentityInput): Promise<ManagedKnowledgePage | undefined>;
  findEligiblePageForConflict(input: EligibleManagedPageForConflictInput): Promise<ManagedKnowledgePage | undefined>;
  linkSource(input: LinkManagedPageSourceInput): Promise<ManagedPageMutationResult>;
  recordSnapshotObservation(input: RecordManagedSnapshotObservationInput): Promise<ManagedSnapshotObservationResult>;
  bindConflictDraft(input: BindManagedUpdateTargetInput): Promise<ManagedTargetMutationResult>;
  getTargetForDraft(input: { draftId: string; revision: number }): Promise<ManagedKnowledgeUpdateTarget | undefined>;
  claimApprovedUpdate(input: ClaimManagedUpdateInput): Promise<ManagedKnowledgeUpdateClaimResult>;
  markRemoteRequestDispatched(input: MarkManagedRemoteRequestDispatchedInput): Promise<ManagedExecutionMutationResult>;
  claimRemoteRetry(input: ClaimManagedRemoteRetryInput): Promise<ManagedExecutionMutationResult>;
  recordRemoteOutcome(input: RecordManagedRemoteOutcomeInput): Promise<ManagedExecutionMutationResult>;
  completeResync(input: CompleteManagedResyncInput): Promise<ManagedExecutionMutationResult>;
  findResyncReadyExecution(input: {
    executionId?: string;
    observationId?: string;
  }): Promise<ManagedResyncReadyExecution | undefined>;
  listReconciliationRequired(input: {
    limit: number;
    dispatchedBefore?: Date;
    claimedBefore?: Date;
  }): Promise<ClaimedManagedKnowledgeUpdate[]>;
  getSourceAvailability(documentSourceId: string): Promise<"available" | "barred">;
  getMetadataForProposal(proposalId: string): Promise<ManagedKnowledgeUpdateMetadata | undefined>;
  requestReconciliation(input: ManagedKnowledgeReconciliationRequest): Promise<ManagedKnowledgeReconciliationRequestResult>;
}

export type { ManagedKnowledgePageState, ManagedKnowledgeUpdateExecutionState };
