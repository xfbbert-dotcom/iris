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

export type DocumentSyncDeadLetter = {
  id: string;
  job: DocumentSyncJob;
  errorMessage: string;
  failedAt: Date;
  replayable: boolean;
};

export type ReplayDocumentSyncDeadLettersResult = {
  replayedCount: number;
  notFoundIds: string[];
  unsupportedLegacyIds: string[];
};

export interface DocumentSyncQueue {
  enqueue(job: DocumentSyncJob): Promise<void>;
  dequeueBatch(limit: number): Promise<DocumentSyncJob[]>;
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
  return `document-sync:${input.documentSourceId}`;
}
