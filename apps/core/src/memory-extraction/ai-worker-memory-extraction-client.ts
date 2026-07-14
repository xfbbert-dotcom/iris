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
  extract(run: ClaimedMemoryExtractionRun): Promise<{
    runId: string;
    candidates: ProposedMemoryCandidate[];
  }>;
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
