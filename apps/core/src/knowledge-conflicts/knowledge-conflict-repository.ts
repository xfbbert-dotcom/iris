import type {
  KnowledgeConflictCandidate,
  KnowledgeConflictCandidateStatus,
  KnowledgeConflictEvidenceReference,
  KnowledgeConflictPlan,
} from "./knowledge-conflict.js";
import type { GroupMemory } from "../memory/group-memory-repository.js";

export type KnowledgeConflictScan = {
  id: string;
  groupId: string;
  groupMemoryId: string;
  memoryUpdatedAt: Date;
  status: "pending" | "processing" | "retry" | "completed" | "dead_lettered";
  attemptCount: number;
  nextAttemptAt: Date;
  leaseWorkerId?: string;
  leaseUntil?: Date;
  terminalOutcome?:
    | "conflict"
    | "no_conflict"
    | "insufficient_evidence"
    | "superseded"
    | "permission_blocked";
  lastErrorCode?: string;
  createdAt: Date;
  updatedAt: Date;
};

export type KnowledgeConflictScanClaim = {
  scan: KnowledgeConflictScan & { status: "processing" };
  memory: GroupMemory;
};

export type KnowledgeConflictScanStatusCounts = {
  pending: number;
  processing: number;
  retry: number;
  completed: number;
  deadLettered: number;
};

export type KnowledgeConflictScanMaintenanceOutcome =
  | { outcome: "superseded"; scanId: string }
  | { outcome: "dead_lettered"; scanId: string; errorCode: "scan_attempts_exhausted" };

export type KnowledgeConflictScanOperationResult = {
  outcome: "applied" | "already_applied";
  scanId: string;
  status: "pending" | "deleted";
};

export type CreateKnowledgeConflictCandidateInput = {
  id: string;
  idempotencyKey: string;
  groupId: string;
  groupMemoryId: string;
  memoryUpdatedAt: Date;
  sourceMessageId: string;
  targetDocumentSourceId: string;
  targetSourceUpdatedAt: Date;
  targetSourceVersion?: string;
  targetSnapshotId: string;
  targetContentHash: string;
  detectorContractVersion: string;
  plan: KnowledgeConflictPlan & { outcome: "conflict" };
  evidence: readonly KnowledgeConflictEvidenceReference[];
  at: Date;
};

export type RecordKnowledgeConflictDetectionInput = {
  scanId: string;
  workerId: string;
  result:
    | { outcome: "no_conflict" | "insufficient_evidence" | "permission_blocked" }
    | {
        outcome: "conflict";
        candidate: Omit<CreateKnowledgeConflictCandidateInput, "at"> & {
          permissionAttestedAt: Date;
        };
      };
  at: Date;
};

export type RecordKnowledgeConflictDetectionResult =
  | {
      outcome: "completed";
      scan: KnowledgeConflictScan & { status: "completed" };
    }
  | (KnowledgeConflictMutationResult & {
      scan: KnowledgeConflictScan & { status: "completed"; terminalOutcome: "conflict" };
    });

export type KnowledgeConflictDelivery = {
  id: string;
  candidateId: string;
  groupId: string;
  status:
    | "pending"
    | "processing"
    | "external_attempting"
    | "sent"
    | "failed"
    | "outcome_unknown"
    | "cancelled";
  retryable: boolean;
  attemptCount: number;
  nextAttemptAt: Date;
  leaseWorkerId?: string;
  leaseUntil?: Date;
  externalAttemptStartedAt?: Date;
  reconciliationDueAt?: Date;
  sentMessageId?: string;
  failureCode?: string;
  createdAt: Date;
  updatedAt: Date;
};

export type KnowledgeConflictDeliveryClaim = {
  delivery: KnowledgeConflictDelivery & { status: "processing" };
  candidate: KnowledgeConflictCandidate;
};

export type KnowledgeConflictInteraction = {
  id: string;
  candidateId: string;
  callbackOperationKey: string;
  actorRef: string;
  action: "dismiss" | "approve_for_delivery" | "create_draft";
  result: "applied" | "already_applied" | "rejected";
  draftId?: string;
  reasonCode?: string;
  createdAt: Date;
};

export type KnowledgeConflictCandidateEvent = {
  id: string;
  candidateId: string;
  operationKey: string;
  actorType: "system" | "feishu_user" | "admin_role";
  actorRef: string;
  fromStatus?: KnowledgeConflictCandidateStatus;
  toStatus: KnowledgeConflictCandidateStatus;
  fromVersion?: number;
  toVersion: number;
  reasonCode: string;
  createdAt: Date;
};

export type KnowledgeConflictCandidateStatusCounts = Record<
  KnowledgeConflictCandidateStatus,
  number
>;

export type KnowledgeConflictDeliveryStatusCounts = {
  pending: number;
  processing: number;
  externalAttempting: number;
  sent: number;
  failed: number;
  terminalFailed: number;
  outcomeUnknown: number;
  cancelled: number;
};

export type KnowledgeConflictInteractionResultCounts = {
  applied: number;
  alreadyApplied: number;
  rejected: number;
};

export type TransitionKnowledgeConflictCandidateInput = {
  id: string;
  expectedVersion: number;
  operationKey: string;
  actorType: "system" | "feishu_user" | "admin_role";
  actorRef: string;
  toStatus: KnowledgeConflictCandidateStatus;
  reasonCode: string;
  at: Date;
};

export type KnowledgeConflictMutationResult = {
  outcome: "applied" | "already_applied";
  candidate: KnowledgeConflictCandidate;
};

export interface KnowledgeConflictRepository {
  discoverEligibleScans(input: {
    groupIds: readonly string[];
    limit: number;
    at: Date;
  }): Promise<{ discovered: number; existing: number }>;
  maintainNextScan(input: {
    groupIds: readonly string[];
    at: Date;
  }): Promise<KnowledgeConflictScanMaintenanceOutcome | undefined>;
  claimNextScan(input: {
    groupIds: readonly string[];
    workerId: string;
    at: Date;
    leaseUntil: Date;
  }): Promise<KnowledgeConflictScanClaim | undefined>;
  completeScan(input: {
    scanId: string;
    workerId: string;
    outcome: Exclude<NonNullable<KnowledgeConflictScan["terminalOutcome"]>, "conflict">;
    at: Date;
  }): Promise<KnowledgeConflictScan>;
  failScan(input: {
    scanId: string;
    workerId: string;
    classification: "retryable" | "permanent";
    errorCode: string;
    retryAt?: Date;
    at: Date;
  }): Promise<{ status: "retry" | "dead_lettered" }>;
  listDeadLetterScans(input: { limit: number }): Promise<KnowledgeConflictScan[]>;
  replayDeadLetterScan(input: {
    scanId: string;
    expectedAttemptCount: number;
    expectedUpdatedAt: Date;
    operationKey: string;
    actorRef: string;
    at: Date;
  }): Promise<KnowledgeConflictScanOperationResult>;
  deleteDeadLetterScan(input: {
    scanId: string;
    expectedAttemptCount: number;
    expectedUpdatedAt: Date;
    operationKey: string;
    actorRef: string;
    at: Date;
  }): Promise<KnowledgeConflictScanOperationResult>;
  getScanStatusCounts(): Promise<KnowledgeConflictScanStatusCounts>;
  recordDetectionResult(
    input: RecordKnowledgeConflictDetectionInput,
  ): Promise<RecordKnowledgeConflictDetectionResult>;
  getCandidate(id: string): Promise<KnowledgeConflictCandidate | undefined>;
  listCandidates(input: {
    groupId?: string;
    statuses?: KnowledgeConflictCandidateStatus[];
    limit: number;
  }): Promise<KnowledgeConflictCandidate[]>;
  listCandidateEvents(input: {
    candidateId: string;
    limit: number;
  }): Promise<KnowledgeConflictCandidateEvent[]>;
  validateCandidateCurrentState(input: {
    candidateId: string;
    expectedVersion: number;
    permissionAttestedAt: Date;
    operationKey: string;
    at: Date;
  }): Promise<
    | { status: "current"; candidate: KnowledgeConflictCandidate }
    | { status: "superseded"; candidate: KnowledgeConflictCandidate; reasonCode: string }
  >;
  dismissCandidate(input: {
    candidateId: string;
    expectedVersion: number;
    operationKey: string;
    actorType: "system" | "feishu_user" | "admin_role";
    actorRef: string;
    reasonCode: string;
    at: Date;
  }): Promise<KnowledgeConflictMutationResult>;
  approveForDelivery(input: {
    candidateId: string;
    expectedVersion: number;
    operationKey: string;
    actorType: "admin_role";
    actorRef: string;
    reasonCode: string;
    at: Date;
  }): Promise<KnowledgeConflictMutationResult & { delivery: KnowledgeConflictDelivery }>;
  claimNextDelivery(input: {
    workerId: string;
    at: Date;
    leaseUntil: Date;
  }): Promise<KnowledgeConflictDeliveryClaim | undefined>;
  beginDeliveryAttempt(input: {
    deliveryId: string;
    candidateId: string;
    expectedCandidateVersion: number;
    expectedAttemptCount: number;
    workerId: string;
    at: Date;
  }): Promise<KnowledgeConflictDelivery>;
  completeDelivery(input: {
    deliveryId: string;
    workerId: string;
    messageId: string;
    at: Date;
  }): Promise<{ delivery: KnowledgeConflictDelivery; candidate: KnowledgeConflictCandidate }>;
  failDelivery(input: {
    deliveryId: string;
    workerId: string;
    classification: "retryable" | "permanent" | "outcome_unknown";
    errorCode: string;
    retryAt?: Date;
    reconciliationDueAt?: Date;
    at: Date;
  }): Promise<KnowledgeConflictDelivery>;
  reconcileDelivery(input: {
    deliveryId: string;
    expectedAttemptCount: number;
    outcome: "sent" | "not_sent";
    operationKey: string;
    actorRef: string;
    messageId?: string;
    at: Date;
  }): Promise<KnowledgeConflictDelivery>;
  getDelivery(id: string): Promise<KnowledgeConflictDelivery | undefined>;
  getDeliveryForCandidate(candidateId: string): Promise<KnowledgeConflictDelivery | undefined>;
  recordInteraction(input: {
    id: string;
    candidateId: string;
    callbackOperationKey: string;
    actorRef: string;
    action: KnowledgeConflictInteraction["action"];
    result: KnowledgeConflictInteraction["result"];
    draftId?: string;
    reasonCode?: string;
    at: Date;
  }): Promise<{
    outcome: "applied" | "already_applied";
    interaction: KnowledgeConflictInteraction;
  }>;
  applyInteraction(input: {
    id: string;
    candidateId: string;
    expectedVersion: number;
    callbackOperationKey: string;
    actorRef: string;
    action: "dismiss" | "create_draft";
    draftId?: string;
    targetPolicyId?: string;
    targetPolicyVersion?: number;
    reasonCode: string;
    permissionAttestedAt: Date;
    at: Date;
  }): Promise<{
    outcome: "applied" | "already_applied";
    interaction: KnowledgeConflictInteraction;
    candidate: KnowledgeConflictCandidate;
  }>;
  findCurrentOverlap(input: {
    groupId: string;
    groupMemoryIds: readonly string[];
    documents: readonly { sourceId: string; snapshotId: string }[];
    permissionAttestedAt: Date;
    at: Date;
  }): Promise<KnowledgeConflictCandidate | undefined>;
  getCandidateStatusCounts(): Promise<KnowledgeConflictCandidateStatusCounts>;
  getDeliveryStatusCounts(): Promise<KnowledgeConflictDeliveryStatusCounts>;
  getInteractionResultCounts(): Promise<KnowledgeConflictInteractionResultCounts>;
}

export class KnowledgeConflictOperationConflictError extends Error {
  constructor() {
    super("knowledge conflict operation conflict");
    this.name = "KnowledgeConflictOperationConflictError";
  }
}

export class KnowledgeConflictVersionConflictError extends Error {
  constructor() {
    super("knowledge conflict version conflict");
    this.name = "KnowledgeConflictVersionConflictError";
  }
}

export class KnowledgeConflictNotFoundError extends Error {
  constructor() {
    super("knowledge conflict candidate not found");
    this.name = "KnowledgeConflictNotFoundError";
  }
}

export class KnowledgeConflictLeaseConflictError extends Error {
  constructor() {
    super("knowledge conflict lease conflict");
    this.name = "KnowledgeConflictLeaseConflictError";
  }
}

export class KnowledgeConflictStaleEvidenceError extends Error {
  constructor(public readonly reasonCode: string) {
    super("knowledge conflict evidence is stale");
    this.name = "KnowledgeConflictStaleEvidenceError";
  }
}

export class KnowledgeConflictDeliveryConflictError extends Error {
  constructor() {
    super("knowledge conflict delivery conflict");
    this.name = "KnowledgeConflictDeliveryConflictError";
  }
}

export class KnowledgeConflictTargetPolicyConflictError extends Error {
  constructor() {
    super("knowledge conflict target policy conflict");
    this.name = "KnowledgeConflictTargetPolicyConflictError";
  }
}
