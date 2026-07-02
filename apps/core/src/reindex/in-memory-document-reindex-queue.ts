import type {
  DocumentReindexJob,
  DocumentReindexQueue,
  FailedDocumentReindexJobInput,
  FailedDocumentReindexJobResult,
} from "./document-reindex-queue.js";

const DEFAULT_MAX_ATTEMPTS = 3;

type DeadLetteredDocumentReindexJob = {
  job: DocumentReindexJob;
  errorMessage: string;
  failedAt: Date;
};

export type InMemoryDocumentReindexQueueOptions = {
  maxAttempts?: number;
};

export class InMemoryDocumentReindexQueue implements DocumentReindexQueue {
  private readonly jobs: DocumentReindexJob[] = [];
  private readonly deadLetters: DeadLetteredDocumentReindexJob[] = [];
  private readonly seenKeys = new Set<string>();
  private readonly maxAttempts: number;

  constructor(options: InMemoryDocumentReindexQueueOptions = {}) {
    this.maxAttempts = sanitizeMaxAttempts(options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  }

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

  async handleFailedJob(
    input: FailedDocumentReindexJobInput,
  ): Promise<FailedDocumentReindexJobResult> {
    const attempts = input.job.attempts + 1;
    const failedJob = { ...input.job, attempts };

    if (attempts >= this.maxAttempts) {
      this.deadLetters.push({
        job: failedJob,
        errorMessage: input.errorMessage,
        failedAt: new Date(),
      });
      return { action: "dead_lettered", attempts };
    }

    this.jobs.push(failedJob);
    return { action: "requeued", attempts };
  }

  async getDeadLetterCount(): Promise<number> {
    return this.deadLetters.length;
  }
}

function sanitizeMaxAttempts(value: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error("maxAttempts must be a positive integer");
  }

  return value;
}
