import type {
  DocumentSyncDeadLetter,
  DocumentSyncJob,
  DocumentSyncQueue,
  ReplayDocumentSyncDeadLettersResult,
} from "./document-sync-queue.js";
import {
  MAX_DOCUMENT_SYNC_IDEMPOTENCY_KEY_CHARS,
  MAX_DOCUMENT_SYNC_JOB_ID_CHARS,
  MAX_DOCUMENT_SYNC_QUEUE_LIMIT,
  createDocumentSyncIdempotencyKey,
} from "./document-sync-queue.js";
import { normalizeDeadLetterErrorMessage } from "../queues/dead-letter-error-message.js";

export type InMemoryDocumentSyncQueueOptions = {
  maxAttempts?: number;
  now?: () => Date;
  idGenerator?: () => string;
};

type DeadLetteredDocumentSyncJob = {
  id: string;
  job: DocumentSyncJob;
  errorMessage: string;
  failedAt: Date;
};

export function createInMemoryDocumentSyncQueue({
  maxAttempts = 3,
  now = () => new Date(),
  idGenerator = defaultIdGenerator,
}: InMemoryDocumentSyncQueueOptions = {}): DocumentSyncQueue {
  const safeMaxAttempts = sanitizeMaxAttempts(maxAttempts);
  const jobsByIdempotencyKey = new Map<string, DocumentSyncJob>();
  const inFlightJobsByIdempotencyKey = new Map<string, DocumentSyncJob>();
  const deadLetters: DeadLetteredDocumentSyncJob[] = [];

  const replayDeadLetter = async (
    id: string,
  ): Promise<"replayed" | "not_found" | "unsupported_legacy_item"> => {
    const index = deadLetters.findIndex((deadLetter) => deadLetter.id === id);
    if (index === -1) {
      return id.startsWith("legacy:") ? "unsupported_legacy_item" : "not_found";
    }

      const [deadLetter] = deadLetters.splice(index, 1);
      if (inFlightJobsByIdempotencyKey.has(deadLetter.job.idempotencyKey)) {
        return "replayed";
      }
      jobsByIdempotencyKey.set(
        deadLetter.job.idempotencyKey,
        cloneJob({ ...deadLetter.job, attempts: 0 }),
    );
    return "replayed";
  };

  const deleteDeadLetter = async (
    id: string,
  ): Promise<"deleted" | "not_found" | "unsupported_legacy_item"> => {
    const index = deadLetters.findIndex((deadLetter) => deadLetter.id === id);
    if (index === -1) {
      return id.startsWith("legacy:") ? "unsupported_legacy_item" : "not_found";
    }

    deadLetters.splice(index, 1);
    return "deleted";
  };

  return {
    async enqueue(job) {
      const clonedJob = cloneJob(job);
      if (
        jobsByIdempotencyKey.has(clonedJob.idempotencyKey) ||
        inFlightJobsByIdempotencyKey.has(clonedJob.idempotencyKey)
      ) {
        return;
      }

      jobsByIdempotencyKey.set(clonedJob.idempotencyKey, clonedJob);
    },

    async dequeueBatch(limit) {
      const batchSize = sanitizeLimit(limit);
      const jobs = Array.from(jobsByIdempotencyKey.values()).slice(0, batchSize);
      for (const job of jobs) {
        jobsByIdempotencyKey.delete(job.idempotencyKey);
        inFlightJobsByIdempotencyKey.set(job.idempotencyKey, cloneJob(job));
      }

      return jobs.map(cloneJob);
    },

    async handleProcessedJob(job) {
      const clonedJob = cloneJob(job);
      inFlightJobsByIdempotencyKey.delete(clonedJob.idempotencyKey);
    },

    async getPendingCount() {
      return jobsByIdempotencyKey.size;
    },

    async handleFailedJob(input) {
      const originalJob = cloneJob(input.job);
      const attempts = originalJob.attempts + 1;
      const failedJob = cloneJob({ ...originalJob, attempts });
      inFlightJobsByIdempotencyKey.delete(originalJob.idempotencyKey);

      if (attempts >= safeMaxAttempts) {
        deadLetters.push({
          id: idGenerator(),
          job: failedJob,
          errorMessage: normalizeDeadLetterErrorMessage(input.errorMessage),
          failedAt: now(),
        });
        return { action: "dead_lettered", attempts };
      }

      jobsByIdempotencyKey.set(failedJob.idempotencyKey, failedJob);
      return { action: "requeued", attempts };
    },

    async getDeadLetterCount() {
      return deadLetters.length;
    },

    async listDeadLetters(input) {
      return deadLetters.slice(0, sanitizeLimit(input.limit)).map(cloneDeadLetter);
    },

    replayDeadLetter,

    deleteDeadLetter,

    async replayDeadLetters(input): Promise<ReplayDocumentSyncDeadLettersResult> {
      const result: ReplayDocumentSyncDeadLettersResult = {
        replayedCount: 0,
        notFoundIds: [],
        unsupportedLegacyIds: [],
      };

      for (const id of new Set(input.ids)) {
        const replayResult = await replayDeadLetter(id);
        if (replayResult === "replayed") {
          result.replayedCount += 1;
        } else if (replayResult === "not_found") {
          result.notFoundIds.push(id);
        } else {
          result.unsupportedLegacyIds.push(id);
        }
      }

      return result;
    },
  };
}

function sanitizeLimit(value: number): number {
  if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) {
    throw new Error("document sync queue limit must be a finite safe-magnitude number");
  }

  return Math.min(MAX_DOCUMENT_SYNC_QUEUE_LIMIT, Math.max(0, Math.floor(value)));
}

function cloneJob(job: DocumentSyncJob): DocumentSyncJob {
  const idempotencyKey = job.idempotencyKey.trim();
  const documentSourceId = job.documentSourceId.trim();
  assertValidJob({ ...job, idempotencyKey, documentSourceId });
  return {
    ...job,
    idempotencyKey,
    documentSourceId,
    enqueuedAt: new Date(job.enqueuedAt),
  };
}

function assertValidJob(job: DocumentSyncJob): void {
  const documentSourceId = job.documentSourceId.trim();
  const idempotencyKey = job.idempotencyKey.trim();
  if (
    documentSourceId.length === 0 ||
    documentSourceId.length > MAX_DOCUMENT_SYNC_JOB_ID_CHARS ||
    idempotencyKey.length === 0 ||
    idempotencyKey.length > MAX_DOCUMENT_SYNC_IDEMPOTENCY_KEY_CHARS ||
    idempotencyKey !== createDocumentSyncIdempotencyKey({ documentSourceId }) ||
    !Number.isInteger(job.attempts) ||
    !Number.isSafeInteger(job.attempts) ||
    job.attempts < 0 ||
    Number.isNaN(job.enqueuedAt.getTime())
  ) {
    throw new Error("Invalid document sync job payload");
  }
}

function cloneDeadLetter(deadLetter: DeadLetteredDocumentSyncJob): DocumentSyncDeadLetter {
  return {
    id: deadLetter.id,
    job: cloneJob(deadLetter.job),
    errorMessage: deadLetter.errorMessage,
    failedAt: new Date(deadLetter.failedAt),
    replayable: true,
  };
}

function sanitizeMaxAttempts(value: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error("maxAttempts must be a positive integer");
  }
  if (!Number.isSafeInteger(value)) {
    throw new Error("maxAttempts must be a positive safe integer");
  }

  return value;
}

function defaultIdGenerator(): string {
  return `dlq_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}
