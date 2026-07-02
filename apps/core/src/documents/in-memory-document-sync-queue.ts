import type { DocumentSyncJob, DocumentSyncQueue } from "./document-sync-queue.js";

export function createInMemoryDocumentSyncQueue(): DocumentSyncQueue {
  const jobsByIdempotencyKey = new Map<string, DocumentSyncJob>();

  return {
    async enqueue(job) {
      if (jobsByIdempotencyKey.has(job.idempotencyKey)) {
        return;
      }

      jobsByIdempotencyKey.set(job.idempotencyKey, cloneJob(job));
    },

    async dequeueBatch(limit) {
      const batchSize = sanitizeLimit(limit);
      const jobs = Array.from(jobsByIdempotencyKey.values()).slice(0, batchSize);
      for (const job of jobs) {
        jobsByIdempotencyKey.delete(job.idempotencyKey);
      }

      return jobs.map(cloneJob);
    },

    async getPendingCount() {
      return jobsByIdempotencyKey.size;
    },
  };
}

function sanitizeLimit(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.floor(value));
}

function cloneJob(job: DocumentSyncJob): DocumentSyncJob {
  return {
    ...job,
    enqueuedAt: new Date(job.enqueuedAt),
  };
}
