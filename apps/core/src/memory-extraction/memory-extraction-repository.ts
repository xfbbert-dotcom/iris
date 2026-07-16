import type {
  MemoryExtractionDiagnostics,
  ValidatedActionOperation,
  ValidatedMemoryCandidate,
  ValidatedMemoryConflictCandidate,
  ValidatedThreadOperation,
} from "./ai-worker-memory-extraction-client.js";

export type MemoryExtractionRequestStatus =
  | "pending"
  | "processing"
  | "completed"
  | "skipped";

export type MemoryExtractionRunStatus = "processing" | "completed" | "failed";

export type MemoryExtractionRequest = {
  id: string;
  groupId: string;
  conversationMessageId: string;
  providerMessageId: string;
  status: MemoryExtractionRequestStatus;
  runId?: string;
  skipReason?: string;
  createdAt: Date;
  updatedAt: Date;
};

export type MemoryExtractionStatusCounts = {
  pending: number;
  processing: number;
  completed: number;
  skipped: number;
  failedRuns: number;
  acceptedCandidates: number;
  rejectedCandidates: number;
  duplicateCandidates: number;
  conflictCandidates: number;
};

export type MemoryExtractionRequestRoute = {
  requestId: string;
  groupId: string;
  status: MemoryExtractionRequestStatus;
  runId?: string;
};

export type ExtractionMessage = {
  id: string;
  groupId: string;
  senderId?: string;
  text: string;
  sentAt: Date;
  createdAt: Date;
  evidenceEligible: boolean;
  mentions?: Array<{ key: string; openId: string }>;
};

export type ExtractionMessageMention = {
  conversationMessageId: string;
  key: string;
  openId: string;
};

export type ExtractionExistingMemory = {
  id: string;
  category: string;
  content: string;
  updatedAt: Date;
};

export type ClaimedMemoryExtractionRun = {
  id: string;
  groupId: string;
  inputFingerprint: string;
  requestIds: string[];
  evidenceMessages: ExtractionMessage[];
  contextMessages: ExtractionMessage[];
  existingMemories: ExtractionExistingMemory[];
  mentions: ExtractionMessageMention[];
  existingThreads: ExtractionExistingThread[];
  existingActions: ExtractionExistingAction[];
  enabledOperationFamilies: Array<"memory" | "thread" | "action">;
  previousFailureClassification?: string;
};

export type ExtractionExistingThread = {
  id: string;
  groupId: string;
  title: string;
  summary: string;
  status: "candidate" | "open" | "resolved" | "merged";
  confidence: number;
  mergedIntoThreadId?: string;
  version: number;
  firstEvidenceAt: Date;
  lastActivityAt: Date;
  resolvedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
};

export type ExtractionExistingAction = {
  id: string;
  groupId: string;
  threadId?: string;
  description: string;
  ownerRefType: "feishu_user" | "text_label";
  ownerRef: string;
  dueAt?: Date;
  status: "open" | "completed" | "cancelled";
  confidence: number;
  version: number;
  completedAt?: Date;
  cancelledAt?: Date;
  createdAt: Date;
  updatedAt: Date;
};

export class MemoryExtractionCompletionConflictError extends Error {
  constructor() {
    super("memory extraction completion conflicts with persisted run");
    this.name = "MemoryExtractionCompletionConflictError";
  }
}

export class MemoryExtractionStaleRunError extends Error {
  constructor() {
    super("memory extraction run input is stale");
    this.name = "MemoryExtractionStaleRunError";
  }
}

export interface MemoryExtractionRepository {
  registerRequest(input: {
    groupId: string;
    conversationMessageId: string;
    providerMessageId: string;
  }): Promise<{ request: MemoryExtractionRequest; created: boolean }>;
  getRequestRoutes(input: {
    requestIds: string[];
  }): Promise<MemoryExtractionRequestRoute[]>;
  claimRun(input: {
    requestIds: string[];
    maxEvidenceMessages: number;
    contextMessageLimit: number;
    activeMemoryLimit: number;
  }): Promise<ClaimedMemoryExtractionRun | undefined>;
  loadRunInput(runId: string): Promise<
    | { status: "ready"; run: ClaimedMemoryExtractionRun }
    | { status: "completed" }
    | { status: "stale"; groupId: string; requestIds: string[] }
    | { status: "not_found" }
  >;
  skipRequest(input: { requestId: string; reason: string }): Promise<void>;
  skipRun(input: { runId: string; reason: string }): Promise<void>;
  failRun(input: { runId: string; classification: string }): Promise<void>;
  completeRun(input: {
    runId: string;
    inputFingerprint: string;
    acceptedCandidates: ValidatedMemoryCandidate[];
    conflictCandidates: ValidatedMemoryConflictCandidate[];
    diagnostics: MemoryExtractionDiagnostics;
    threadOperations?: ValidatedThreadOperation[];
    actionOperations?: ValidatedActionOperation[];
    conversationStateDiagnostics?: {
      proposedCount: number;
      acceptedCount: number;
      rejectedCount: number;
      rejectionCodes: string[];
    };
  }): Promise<{
    status: "completed" | "already_completed";
    memoryIds: string[];
    threadIds?: string[];
    actionItemIds?: string[];
  }>;
  getStatusCounts(): Promise<MemoryExtractionStatusCounts>;
}
