import type { DocumentReindexJob, DocumentReindexQueue } from "./document-reindex-queue.js";

export class InMemoryDocumentReindexQueue implements DocumentReindexQueue {
  private readonly jobs: DocumentReindexJob[] = [];
  private readonly seenKeys = new Set<string>();

  async enqueue(job: DocumentReindexJob): Promise<void> {
    if (this.seenKeys.has(job.idempotencyKey)) {
      return;
    }

    this.seenKeys.add(job.idempotencyKey);
    this.jobs.push(job);
  }

  async dequeueBatch(limit: number): Promise<DocumentReindexJob[]> {
    const safeLimit = Math.max(0, Math.floor(limit));
    return this.jobs.splice(0, safeLimit);
  }

  async getPendingCount(): Promise<number> {
    return this.jobs.length;
  }
}
