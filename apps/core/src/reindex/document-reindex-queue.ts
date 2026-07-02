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
}

export function createDocumentReindexIdempotencyKey(
  input: CreateDocumentReindexIdempotencyKeyInput,
): string {
  return `reindex:${input.embeddingProfileId}:${input.documentSnapshotId}`;
}
