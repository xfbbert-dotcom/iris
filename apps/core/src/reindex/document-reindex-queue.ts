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

export type DocumentReindexJobDeadLetter = {
  id: string;
  job: DocumentReindexJob;
  errorMessage: string;
  failedAt: Date;
  replayable: boolean;
};

export type DocumentReindexInvalidPayloadDeadLetter = {
  id: string;
  rawPayload: string;
  errorMessage: string;
  failedAt: Date;
  replayable: false;
};

export type DocumentReindexDeadLetter =
  | DocumentReindexJobDeadLetter
  | DocumentReindexInvalidPayloadDeadLetter;

export type ReplayDocumentReindexDeadLettersResult = {
  replayedCount: number;
  notFoundIds: string[];
  unsupportedLegacyIds: string[];
};

export type CreateDocumentReindexIdempotencyKeyInput = {
  embeddingProfileId: string;
  documentSnapshotId: string;
};

export const MAX_DOCUMENT_REINDEX_JOB_ID_CHARS = 512;
export const MAX_DOCUMENT_REINDEX_QUEUE_LIMIT = 100;
const DOCUMENT_REINDEX_IDEMPOTENCY_KEY_PREFIX = "reindex:";
export const MAX_DOCUMENT_REINDEX_IDEMPOTENCY_KEY_CHARS =
  DOCUMENT_REINDEX_IDEMPOTENCY_KEY_PREFIX.length +
  MAX_DOCUMENT_REINDEX_JOB_ID_CHARS +
  1 +
  MAX_DOCUMENT_REINDEX_JOB_ID_CHARS;

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
  return `${DOCUMENT_REINDEX_IDEMPOTENCY_KEY_PREFIX}${normalizeNonBlankId(
    input.embeddingProfileId,
    "embeddingProfileId",
  )}:${normalizeNonBlankId(input.documentSnapshotId, "documentSnapshotId")}`;
}

function normalizeNonBlankId(value: string, fieldName: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error(`${fieldName} must be nonblank`);
  }
  if (normalized.length > MAX_DOCUMENT_REINDEX_JOB_ID_CHARS) {
    throw new Error(`${fieldName} must be at most ${MAX_DOCUMENT_REINDEX_JOB_ID_CHARS} characters`);
  }

  return normalized;
}
