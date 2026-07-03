export type DocumentReindexReason = "document_synced" | "manual_profile_reindex";

export type DocumentReindexJob = {
  idempotencyKey: string;
  embeddingProfileId: string;
  documentSnapshotId: string;
  reason: DocumentReindexReason;
  enqueuedAt: Date;
  attempts: number;
};

export type FailedDocumentReindexJobInput = {
  job: DocumentReindexJob;
  errorMessage: string;
};

export type FailedDocumentReindexJobResult = {
  action: "requeued" | "dead_lettered";
  attempts: number;
};

export type DocumentReindexDeadLetter = {
  id: string;
  job: DocumentReindexJob;
  errorMessage: string;
  failedAt: Date;
  replayable: boolean;
};

export type ReplayDocumentReindexDeadLettersResult = {
  replayedCount: number;
  notFoundIds: string[];
  unsupportedLegacyIds: string[];
};

export type CreateDocumentReindexIdempotencyKeyInput = {
  embeddingProfileId: string;
  documentSnapshotId: string;
};

export interface DocumentReindexQueue {
  enqueue(job: DocumentReindexJob): Promise<void>;
  dequeueBatch(limit: number): Promise<DocumentReindexJob[]>;
  getPendingCount(): Promise<number>;
  handleFailedJob(
    input: FailedDocumentReindexJobInput,
  ): Promise<FailedDocumentReindexJobResult>;
  getDeadLetterCount(): Promise<number>;
  listDeadLetters(input: { limit: number }): Promise<DocumentReindexDeadLetter[]>;
  replayDeadLetter(id: string): Promise<"replayed" | "not_found" | "unsupported_legacy_item">;
  deleteDeadLetter(id: string): Promise<"deleted" | "not_found" | "unsupported_legacy_item">;
  replayDeadLetters(input: { ids: string[] }): Promise<ReplayDocumentReindexDeadLettersResult>;
}

export function createDocumentReindexIdempotencyKey(
  input: CreateDocumentReindexIdempotencyKeyInput,
): string {
  return `reindex:${normalizeNonBlankId(
    input.embeddingProfileId,
    "embeddingProfileId",
  )}:${normalizeNonBlankId(input.documentSnapshotId, "documentSnapshotId")}`;
}

function normalizeNonBlankId(value: string, fieldName: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error(`${fieldName} must be nonblank`);
  }

  return normalized;
}
