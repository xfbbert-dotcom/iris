export type DocumentSyncReason = "discovered_group_document";

export type DocumentSyncJob = {
  idempotencyKey: string;
  documentSourceId: string;
  reason: DocumentSyncReason;
  enqueuedAt: Date;
  attempts: number;
};

export interface DocumentSyncQueue {
  enqueue(job: DocumentSyncJob): Promise<void>;
  dequeueBatch(limit: number): Promise<DocumentSyncJob[]>;
  getPendingCount(): Promise<number>;
}

export function createDocumentSyncIdempotencyKey(input: {
  documentSourceId: string;
}): string {
  return `document-sync:${input.documentSourceId}`;
}
