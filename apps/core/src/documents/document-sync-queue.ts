export type DocumentSyncReason = "discovered_group_document" | "manual_source_sync";

export type DocumentSyncJob = {
  idempotencyKey: string;
  documentSourceId: string;
  reason: DocumentSyncReason;
  enqueuedAt: Date;
  attempts: number;
};

export type FailedDocumentSyncJobInput = {
  job: DocumentSyncJob;
  errorMessage: string;
};

export type FailedDocumentSyncJobResult = {
  action: "requeued" | "dead_lettered";
  attempts: number;
};

export type DocumentSyncJobDeadLetter = {
  id: string;
  job: DocumentSyncJob;
  errorMessage: string;
  failedAt: Date;
  replayable: boolean;
};

export type DocumentSyncInvalidPayloadDeadLetter = {
  id: string;
  rawPayload: string;
  errorMessage: string;
  failedAt: Date;
  replayable: false;
};

export type DocumentSyncDeadLetter =
  | DocumentSyncJobDeadLetter
  | DocumentSyncInvalidPayloadDeadLetter;

export type ReplayDocumentSyncDeadLettersResult = {
  replayedCount: number;
  notFoundIds: string[];
  unsupportedLegacyIds: string[];
};

export const MAX_DOCUMENT_SYNC_JOB_ID_CHARS = 512;
export const MAX_DOCUMENT_SYNC_QUEUE_LIMIT = 100;
const DOCUMENT_SYNC_IDEMPOTENCY_KEY_PREFIX = "document-sync:";
export const MAX_DOCUMENT_SYNC_IDEMPOTENCY_KEY_CHARS =
  DOCUMENT_SYNC_IDEMPOTENCY_KEY_PREFIX.length + MAX_DOCUMENT_SYNC_JOB_ID_CHARS;

export interface DocumentSyncQueue {
  enqueue(job: DocumentSyncJob): Promise<void>;
  dequeueBatch(limit: number): Promise<DocumentSyncJob[]>;
  handleProcessedJob(job: DocumentSyncJob): Promise<void>;
  getPendingCount(): Promise<number>;
  handleFailedJob(input: FailedDocumentSyncJobInput): Promise<FailedDocumentSyncJobResult>;
  getDeadLetterCount(): Promise<number>;
  listDeadLetters(input: { limit: number }): Promise<DocumentSyncDeadLetter[]>;
  replayDeadLetter(id: string): Promise<"replayed" | "not_found" | "unsupported_legacy_item">;
  deleteDeadLetter(id: string): Promise<"deleted" | "not_found" | "unsupported_legacy_item">;
  replayDeadLetters(
    input: { ids: string[] },
  ): Promise<ReplayDocumentSyncDeadLettersResult>;
}

export function createDocumentSyncIdempotencyKey(input: {
  documentSourceId: string;
}): string {
  return `${DOCUMENT_SYNC_IDEMPOTENCY_KEY_PREFIX}${normalizeNonBlankId(
    input.documentSourceId,
    "documentSourceId",
  )}`;
}

function normalizeNonBlankId(value: string, fieldName: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error(`${fieldName} must be nonblank`);
  }
  if (normalized.length > MAX_DOCUMENT_SYNC_JOB_ID_CHARS) {
    throw new Error(`${fieldName} must be at most ${MAX_DOCUMENT_SYNC_JOB_ID_CHARS} characters`);
  }

  return normalized;
}
