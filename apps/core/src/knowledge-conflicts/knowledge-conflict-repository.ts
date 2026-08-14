import type {
  KnowledgeConflictCandidate,
  KnowledgeConflictCandidateStatus,
  KnowledgeConflictEvidenceReference,
  KnowledgeConflictPlan,
} from "./knowledge-conflict.js";

export type CreateKnowledgeConflictCandidateInput = {
  id: string;
  idempotencyKey: string;
  groupId: string;
  groupMemoryId: string;
  memoryUpdatedAt: Date;
  sourceMessageId: string;
  targetDocumentSourceId: string;
  targetSnapshotId: string;
  targetContentHash: string;
  detectorContractVersion: string;
  plan: KnowledgeConflictPlan & { outcome: "conflict" };
  evidence: readonly KnowledgeConflictEvidenceReference[];
  at: Date;
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
  createCandidate(
    input: CreateKnowledgeConflictCandidateInput,
  ): Promise<KnowledgeConflictMutationResult>;
  transitionCandidate(
    input: TransitionKnowledgeConflictCandidateInput,
  ): Promise<KnowledgeConflictMutationResult>;
  getCandidate(id: string): Promise<KnowledgeConflictCandidate | undefined>;
  listCandidates(input: {
    groupId?: string;
    statuses?: KnowledgeConflictCandidateStatus[];
    limit: number;
  }): Promise<KnowledgeConflictCandidate[]>;
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
