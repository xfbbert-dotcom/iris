import type {
  ManagedKnowledgePage,
  ManagedKnowledgePageState,
  ManagedKnowledgeUpdateExecution,
  ManagedKnowledgeUpdateExecutionState,
  ManagedKnowledgeUpdateTarget,
  ManagedSnapshotObservation,
} from "./managed-knowledge-page.js";

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
  id: string;
  proposalId: string;
  updateTargetId: string;
  expectedManagedPageVersion: number;
  operationKey: string;
  clientToken: string;
  workerId: string;
  at: Date;
};

export type RecordManagedRemoteOutcomeInput = {
  executionId: string;
  expectedExecutionVersion: number;
  classification: "preflight_failed" | "outcome_unknown" | "remote_applied" | "failed" | "reconciliation_required";
  responseClassification?: string;
  responseRevisionId?: string;
  reconciliationReasonCode?: string;
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

export type CompleteManagedResyncInput = {
  executionId: string;
  expectedExecutionVersion: number;
  observationId: string;
  operationKey: string;
  actor: string;
  at: Date;
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
  page: ManagedKnowledgePage;
  target: ManagedKnowledgeUpdateTarget;
  execution: ManagedKnowledgeUpdateExecution;
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
  claimApprovedUpdate(input: ClaimManagedUpdateInput): Promise<ClaimedManagedKnowledgeUpdate>;
  markRemoteRequestDispatched(input: MarkManagedRemoteRequestDispatchedInput): Promise<ManagedExecutionMutationResult>;
  recordRemoteOutcome(input: RecordManagedRemoteOutcomeInput): Promise<ManagedExecutionMutationResult>;
  completeResync(input: CompleteManagedResyncInput): Promise<ManagedExecutionMutationResult>;
  listReconciliationRequired(input: { limit: number; dispatchedBefore?: Date }): Promise<ClaimedManagedKnowledgeUpdate[]>;
  getSourceAvailability(documentSourceId: string): Promise<"available" | "barred">;
}

export type { ManagedKnowledgePageState, ManagedKnowledgeUpdateExecutionState };
