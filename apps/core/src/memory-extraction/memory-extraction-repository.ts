import type {
  MemoryExtractionDiagnostics,
  ValidatedMemoryCandidate,
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
  previousFailureClassification?: string;
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
    diagnostics: MemoryExtractionDiagnostics;
  }): Promise<{ status: "completed" | "already_completed"; memoryIds: string[] }>;
  getStatusCounts(): Promise<MemoryExtractionStatusCounts>;
}
