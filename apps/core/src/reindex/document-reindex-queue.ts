export type DocumentReindexReason = "document_synced" | "manual_profile_reindex";

export type DocumentReindexJob = {
  idempotencyKey: string;
  embeddingProfileId: string;
  documentSnapshotId: string;
  reason: DocumentReindexReason;
  enqueuedAt: Date;
};

export type CreateDocumentReindexIdempotencyKeyInput = {
  embeddingProfileId: string;
  documentSnapshotId: string;
};

export interface DocumentReindexQueue {
  enqueue(job: DocumentReindexJob): Promise<void>;
  dequeueBatch(limit: number): Promise<DocumentReindexJob[]>;
}

export function createDocumentReindexIdempotencyKey(
  input: CreateDocumentReindexIdempotencyKeyInput,
): string {
  return `reindex:${input.embeddingProfileId}:${input.documentSnapshotId}`;
}
