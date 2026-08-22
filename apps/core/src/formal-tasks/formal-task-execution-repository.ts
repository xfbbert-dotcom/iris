import type { FeishuTaskSnapshot } from "./feishu-task-creator.js";

export class FormalTaskCreationDueExpiredError extends Error {
  constructor() {
    super("formal task due time expired before dispatch");
    this.name = "FormalTaskCreationDueExpiredError";
  }
}

export type FeishuTaskCreationExecutionState =
  | "claimed"
  | "external_attempting"
  | "succeeded"
  | "failed"
  | "outcome_unknown"
  | "reconciliation_required";

export type FeishuTaskCreationExecution = {
  id: string;
  proposalId: string;
  state: FeishuTaskCreationExecutionState;
  attemptNumber: number;
  version: number;
  requestFingerprint: string;
  clientTokenHash: string;
  responseClassification?: string;
  remoteTaskGuid?: string;
  remoteTaskId?: string;
  remoteTaskUrl?: string;
  workerId?: string;
  leaseUntil?: Date;
  retryAt?: Date;
  dispatchedAt?: Date;
  createdAt?: Date;
  updatedAt?: Date;
};

export type ClaimedFeishuTaskCreation = {
  proposal: { id: string; version: number };
  approvalId: string;
  execution: FeishuTaskCreationExecution;
  draft: {
    id: string;
    revision: number;
    version: number;
    sourceGroupId: string;
    title: string;
    description: string;
    assigneeOpenId: string;
    dueAt?: Date;
    reminderMinutes?: 0 | 30 | 60 | 1440;
    taskSpecHash: string;
  };
  policy: { id: string; version: number };
  clientToken: string;
};

export type FeishuTaskCreationRuntimeGate = {
  deploymentEnabled: boolean;
  globalEnabled: boolean;
  createFeishuTasks: boolean;
  callExternalTools: boolean;
  disabledGroupIds: string[];
  allowedGroupIds: string[];
};

export type RecordFeishuTaskCreationFailureInput = {
  proposalId: string;
  executionId: string;
  expectedProposalVersion: number;
  expectedExecutionVersion: number;
  classification: "retryable" | "failed" | "outcome_unknown" | "reconciliation_required";
  responseClassification: string;
  retryAt?: Date;
  remoteTaskGuid?: string;
  remoteTaskId?: string;
  remoteTaskUrl?: string;
  operationKey: string;
  at: Date;
};

export type CompleteFeishuTaskCreationInput = {
  proposalId: string;
  executionId: string;
  expectedProposalVersion: number;
  expectedExecutionVersion: number;
  expectedDraftVersion: number;
  expectedDraftRevision: number;
  taskSpecHash: string;
  remoteTaskGuid: string;
  remoteTaskId: string;
  remoteTaskUrl: string;
  operationKey: string;
  at: Date;
};

export type FeishuTaskCreation = {
  id: string;
  proposalId: string;
  executionId: string;
  draftId: string;
  draftRevision: number;
  draftVersion: number;
  sourceGroupId: string;
  title: string;
  assigneeOpenId: string;
  dueAt?: Date;
  reminderMinutes?: 0 | 30 | 60 | 1440;
  remoteTaskGuid: string;
  remoteTaskId: string;
  remoteTaskUrl: string;
  taskSpecHash: string;
  completedAt: Date;
};

export type FeishuTaskResultPresentation = {
  id: string;
  creationId: string;
  proposalId: string;
  groupId: string;
  state: "pending_send" | "sent" | "failed" | "outcome_unknown";
  messageId?: string;
  version: number;
  createdAt: Date;
  sentAt?: Date;
};

export type FeishuTaskResultPresentationContext = {
  presentation: FeishuTaskResultPresentation;
  creation: FeishuTaskCreation;
};

export type FeishuTaskResultSendClaim = {
  presentation: FeishuTaskResultPresentation;
  workerId: string;
  leaseUntil: Date;
  attempts: number;
};

export type FormalTaskExecutionMetadata = {
  id: string;
  proposalId: string;
  draftId: string;
  draftRevision: number;
  draftVersion: number;
  targetPolicyId: string;
  targetPolicyVersion: number;
  attemptNumber: number;
  state: FeishuTaskCreationExecutionState;
  requestFingerprint: string;
  clientTokenHash: string;
  responseClassification?: string;
  version: number;
  leaseUntil?: Date;
  retryAt?: Date;
  dispatchedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
};

export type FormalTaskExecutionStatusCounts = {
  migration0057Applied: boolean;
  executions: Record<FeishuTaskCreationExecutionState, number>;
  results: Record<FeishuTaskResultPresentation["state"], number>;
  outbox: Record<
    "pending" | "processing" | "external_attempting" | "sent" | "failed" |
      "outcome_unknown",
    number
  >;
};

export type RequestFormalTaskReconciliationInput = {
  executionId: string;
  expectedExecutionVersion: number;
  operationKey: string;
  operator: string;
  at: Date;
};

export type RequestFormalTaskReconciliationResult = {
  outcome: "applied" | "already_applied";
  executionId: string;
  state: "outcome_unknown";
  version: number;
  retryAt: Date;
};

export interface FormalTaskExecutionRepository {
  getStatusCounts(): Promise<FormalTaskExecutionStatusCounts>;
  listExecutionMetadata(input: {
    states?: FeishuTaskCreationExecutionState[];
    proposalId?: string;
    limit: number;
  }): Promise<FormalTaskExecutionMetadata[]>;
  requestReconciliation(
    input: RequestFormalTaskReconciliationInput,
  ): Promise<RequestFormalTaskReconciliationResult>;
  claimNextCreation(input: {
    runtimeGate: FeishuTaskCreationRuntimeGate;
    workerId: string;
    leaseUntil: Date;
    operationKey: string;
    at: Date;
  }): Promise<ClaimedFeishuTaskCreation | undefined>;
  claimReconciliationAttempt(input: {
    runtimeGate: FeishuTaskCreationRuntimeGate;
    workerId: string;
    leaseUntil: Date;
    operationKey: string;
    at: Date;
  }): Promise<ClaimedFeishuTaskCreation | undefined>;
  markExternalAttempt(input: {
    executionId: string;
    expectedExecutionVersion: number;
    workerId: string;
    operationKey: string;
    at: Date;
  }): Promise<ClaimedFeishuTaskCreation>;
  completeCreation(input: CompleteFeishuTaskCreationInput): Promise<void>;
  recordCreationFailure(input: RecordFeishuTaskCreationFailureInput): Promise<void>;
  claimResultPresentationSend(input: {
    workerId: string;
    leaseUntil: Date;
    at: Date;
  }): Promise<FeishuTaskResultSendClaim | undefined>;
  getResultPresentationContext(
    presentationId: string,
  ): Promise<FeishuTaskResultPresentationContext | undefined>;
  beginResultPresentationAttempt(input: {
    presentationId: string;
    workerId: string;
    at: Date;
  }): Promise<void>;
  deferResultPresentationSend(input: {
    presentationId: string;
    workerId: string;
    errorCode: string;
    retryAt: Date;
    at: Date;
  }): Promise<void>;
  failResultPresentationPreparation(input: {
    presentationId: string;
    workerId: string;
    errorCode: string;
    at: Date;
  }): Promise<void>;
  completeResultPresentationSend(input: {
    presentationId: string;
    workerId: string;
    messageId: string;
    at: Date;
  }): Promise<void>;
  failResultPresentationSend(input: {
    presentationId: string;
    workerId: string;
    classification: "retryable" | "permanent" | "outcome_unknown";
    errorCode: string;
    retryAt?: Date;
    at: Date;
  }): Promise<void>;
}

export function matchesApprovedTaskProjection(
  claim: ClaimedFeishuTaskCreation,
  task: FeishuTaskSnapshot,
): boolean {
  const expectedDue = claim.draft.dueAt?.getTime();
  const actualDue = task.dueAt?.getTime();
  return task.title === claim.draft.title &&
    task.description === claim.draft.description &&
    expectedDue === actualDue &&
    (expectedDue === undefined || task.dueIsAllDay === false) &&
    task.reminderMinutes === claim.draft.reminderMinutes &&
    task.members.length === 1 &&
    task.members[0]?.id === claim.draft.assigneeOpenId &&
    task.members[0]?.type === "user" &&
    task.members[0]?.role === "assignee";
}
