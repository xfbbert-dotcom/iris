import type { DocumentSyncJob, DocumentSyncQueue } from "./document-sync-queue.js";

export type InMemoryDocumentSyncQueueOptions = {
  maxAttempts?: number;
  now?: () => Date;
};

type DeadLetteredDocumentSyncJob = {
  job: DocumentSyncJob;
  errorMessage: string;
  failedAt: Date;
};

export function createInMemoryDocumentSyncQueue({
  maxAttempts = 3,
  now = () => new Date(),
}: InMemoryDocumentSyncQueueOptions = {}): DocumentSyncQueue {
  const safeMaxAttempts = sanitizeMaxAttempts(maxAttempts);
  const jobsByIdempotencyKey = new Map<string, DocumentSyncJob>();
  const deadLetters: DeadLetteredDocumentSyncJob[] = [];

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

    async handleFailedJob(input) {
      const attempts = input.job.attempts + 1;
      const failedJob = { ...input.job, attempts };

      if (attempts >= safeMaxAttempts) {
        deadLetters.push({
          job: cloneJob(failedJob),
          errorMessage: input.errorMessage,
          failedAt: now(),
        });
        return { action: "dead_lettered", attempts };
      }

      jobsByIdempotencyKey.set(failedJob.idempotencyKey, cloneJob(failedJob));
      return { action: "requeued", attempts };
    },

    async getDeadLetterCount() {
      return deadLetters.length;
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

function sanitizeMaxAttempts(value: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error("maxAttempts must be a positive integer");
  }

  return value;
}
