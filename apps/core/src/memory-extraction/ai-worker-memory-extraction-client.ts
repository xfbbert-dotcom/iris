import type { ClaimedMemoryExtractionRun } from "./memory-extraction-repository.js";

export const MEMORY_CANDIDATE_CATEGORIES = [
  "project",
  "preference",
  "person",
  "term",
  "workflow",
  "decision",
] as const;

export type ProposedMemoryCandidate = {
  category: (typeof MEMORY_CANDIDATE_CATEGORIES)[number];
  content: string;
  importance: number;
  confidence: number;
  evidenceMessageIds: string[];
  relation: "new" | "duplicate" | "conflict";
  existingMemoryId?: string;
};

export type ValidatedMemoryCandidate = {
  category: ProposedMemoryCandidate["category"];
  content: string;
  importance: number;
  confidence: number;
  evidenceMessageIds: string[];
};

export type ValidatedMemoryConflictCandidate = ValidatedMemoryCandidate & {
  existingMemoryId: string;
};

export type ProposedEvidenceBoundOperation = {
  operationKey: string;
  confidence: number;
  evidenceMessageIds: string[];
  evidenceSpan: string;
};

export type ProposedThreadOperation = ProposedEvidenceBoundOperation & (
  | { operation: "create"; title: string; summary: string; initialStatus: "candidate" | "open" }
  | { operation: "attach_evidence"; threadId: string; expectedVersion: number }
  | { operation: "promote"; threadId: string; expectedVersion: number; summary: string }
  | { operation: "merge"; sourceThreadId: string; targetThreadId: string; expectedVersion: number }
  | { operation: "resolve"; threadId: string; expectedVersion: number }
  | { operation: "reopen"; threadId: string; expectedVersion: number }
  | { operation: "update_summary"; threadId: string; expectedVersion: number; summary: string }
  | {
    operation: "correct";
    threadId: string;
    expectedVersion: number;
    correctedFields: Array<"title" | "summary">;
    title?: string;
    summary?: string;
  }
);

export type ProposedActionOwner =
  | { ownerType: "sender"; messageId: string }
  | { ownerType: "mention"; messageId: string; mentionKey: string }
  | { ownerType: "text_label"; messageId: string; label: string };

export type ProposedActionOperation = ProposedEvidenceBoundOperation & (
  | {
    operation: "create";
    threadId?: string | null;
    description: string;
    owner: ProposedActionOwner;
    dueAt?: string;
    dueEvidenceSpan?: string;
  }
  | { operation: "complete"; actionId: string; expectedVersion: number }
  | { operation: "cancel"; actionId: string; expectedVersion: number }
  | { operation: "reopen"; actionId: string; expectedVersion: number }
  | { operation: "resolve_owner"; actionId: string; expectedVersion: number; owner: ProposedActionOwner }
  | {
    operation: "correct";
    actionId: string;
    expectedVersion: number;
    correctedFields: Array<"description" | "thread_id" | "owner">;
    description?: string;
    threadId?: string | null;
    owner?: ProposedActionOwner;
  }
);

export type ValidatedThreadOperation = ProposedThreadOperation;
export type ValidatedActionOperation = ProposedActionOperation & {
  ownerRefType?: "feishu_user" | "text_label";
  ownerRef?: string;
  ownerResolved?: boolean;
};

export type AiWorkerExtractionResponse = {
  runId: string;
  candidates: ProposedMemoryCandidate[];
  threadOperations?: ProposedThreadOperation[];
  actionOperations?: ProposedActionOperation[];
};

export type MemoryExtractionDiagnostics = {
  proposedCount: number;
  acceptedCount: number;
  rejectedCount: number;
  duplicateCount: number;
  conflictCount: number;
  rejectionCodes: string[];
};

export interface AiWorkerMemoryExtractionClient {
  checkHealth(): Promise<boolean>;
  extract(run: ClaimedMemoryExtractionRun): Promise<AiWorkerExtractionResponse>;
}

export type AiWorkerMemoryExtractionErrorCode =
  | "timeout"
  | "rate_limited"
  | "unavailable"
  | "invalid_response"
  | "unauthorized";

export class AiWorkerMemoryExtractionError extends Error {
  constructor(
    readonly code: AiWorkerMemoryExtractionErrorCode,
    readonly retryable: boolean,
    readonly retryAfterMs?: number,
  ) {
    super(code);
    this.name = "AiWorkerMemoryExtractionError";
  }
}
