import type {
  DocumentReindexDeadLetter,
  DocumentReindexJob,
  DocumentReindexQueue,
  FailedDocumentReindexJobInput,
  FailedDocumentReindexJobResult,
  ReplayDocumentReindexDeadLettersResult,
} from "./document-reindex-queue.js";

const DEFAULT_MAX_ATTEMPTS = 3;

type DeadLetteredDocumentReindexJob = {
  id: string;
  job: DocumentReindexJob;
  errorMessage: string;
  failedAt: Date;
};

export type InMemoryDocumentReindexQueueOptions = {
  maxAttempts?: number;
  idGenerator?: () => string;
  now?: () => Date;
};

export class InMemoryDocumentReindexQueue implements DocumentReindexQueue {
  private readonly jobs: DocumentReindexJob[] = [];
  private readonly deadLetters: DeadLetteredDocumentReindexJob[] = [];
  private readonly seenKeys = new Set<string>();
  private readonly maxAttempts: number;
  private readonly idGenerator: () => string;
  private readonly now: () => Date;

  constructor(options: InMemoryDocumentReindexQueueOptions = {}) {
    this.maxAttempts = sanitizeMaxAttempts(options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
    this.idGenerator = options.idGenerator ?? defaultIdGenerator;
    this.now = options.now ?? (() => new Date());
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
        id: this.idGenerator(),
        job: failedJob,
        errorMessage: input.errorMessage,
        failedAt: this.now(),
      });
      return { action: "dead_lettered", attempts };
    }

    this.jobs.push(failedJob);
    return { action: "requeued", attempts };
  }

  async getDeadLetterCount(): Promise<number> {
    return this.deadLetters.length;
  }

  async listDeadLetters(input: { limit: number }): Promise<DocumentReindexDeadLetter[]> {
    const safeLimit = Math.max(0, Math.floor(input.limit));
    return this.deadLetters.slice(0, safeLimit).map((item) => ({
      ...item,
      replayable: true,
    }));
  }

  async replayDeadLetter(
    id: string,
  ): Promise<"replayed" | "not_found" | "unsupported_legacy_item"> {
    const index = this.deadLetters.findIndex((item) => item.id === id);
    if (index === -1) {
      return "not_found";
    }

    const [item] = this.deadLetters.splice(index, 1);
    this.jobs.push({ ...item.job, attempts: 0 });
    return "replayed";
  }

  async deleteDeadLetter(
    id: string,
  ): Promise<"deleted" | "not_found" | "unsupported_legacy_item"> {
    const index = this.deadLetters.findIndex((item) => item.id === id);
    if (index === -1) {
      return "not_found";
    }

    this.deadLetters.splice(index, 1);
    return "deleted";
  }

  async replayDeadLetters(
    input: { ids: string[] },
  ): Promise<ReplayDocumentReindexDeadLettersResult> {
    const result: ReplayDocumentReindexDeadLettersResult = {
      replayedCount: 0,
      notFoundIds: [],
      unsupportedLegacyIds: [],
    };

    for (const id of input.ids) {
      const replayResult = await this.replayDeadLetter(id);
      if (replayResult === "replayed") {
        result.replayedCount += 1;
      } else if (replayResult === "not_found") {
        result.notFoundIds.push(id);
      } else {
        result.unsupportedLegacyIds.push(id);
      }
    }

    return result;
  }
}

function sanitizeMaxAttempts(value: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error("maxAttempts must be a positive integer");
  }

  return value;
}

function defaultIdGenerator(): string {
  return `dlq_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}
