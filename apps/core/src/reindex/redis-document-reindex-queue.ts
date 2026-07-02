import type {
  DocumentReindexJob,
  DocumentReindexQueue,
  FailedDocumentReindexJobInput,
  FailedDocumentReindexJobResult,
} from "./document-reindex-queue.js";

const DEFAULT_SEEN_KEY = "iris:reindex:documents:seen";
const DEFAULT_QUEUE_KEY = "iris:reindex:documents:queue";
const DEFAULT_DEAD_LETTER_KEY = "iris:reindex:documents:dlq";
const DEFAULT_MAX_ATTEMPTS = 3;

const ENQUEUE_SCRIPT = `
if redis.call("SADD", KEYS[1], ARGV[1]) == 1 then
  return redis.call("RPUSH", KEYS[2], ARGV[2])
end
return 0
`;

export type RedisDocumentReindexQueueClient = {
  eval(
    script: string,
    options: { keys: string[]; arguments: string[] },
  ): Promise<number | string>;
  rPush(key: string, value: string): Promise<number>;
  lPop(key: string): Promise<string | null>;
  lLen(key: string): Promise<number>;
};

export type RedisDocumentReindexQueueOptions = {
  client: RedisDocumentReindexQueueClient;
  seenKey?: string;
  queueKey?: string;
  deadLetterKey?: string;
  maxAttempts?: number;
  now?: () => Date;
};

export function createRedisDocumentReindexQueue({
  client,
  seenKey = DEFAULT_SEEN_KEY,
  queueKey = DEFAULT_QUEUE_KEY,
  deadLetterKey = DEFAULT_DEAD_LETTER_KEY,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  now = () => new Date(),
}: RedisDocumentReindexQueueOptions): DocumentReindexQueue {
  const safeMaxAttempts = sanitizeMaxAttempts(maxAttempts);

  return {
    async enqueue(job) {
      await client.eval(ENQUEUE_SCRIPT, {
        keys: [seenKey, queueKey],
        arguments: [job.idempotencyKey, serializeDocumentReindexJob(job)],
      });
    },

    async dequeueBatch(limit) {
      const safeLimit = Math.max(0, Math.floor(limit));
      const jobs: DocumentReindexJob[] = [];

      for (let index = 0; index < safeLimit; index += 1) {
        const payload = await client.lPop(queueKey);
        if (payload === null) {
          break;
        }

        jobs.push(parseDocumentReindexJob(payload));
      }

      return jobs;
    },

    getPendingCount() {
      return client.lLen(queueKey);
    },

    async handleFailedJob(
      input: FailedDocumentReindexJobInput,
    ): Promise<FailedDocumentReindexJobResult> {
      const attempts = input.job.attempts + 1;
      const failedJob = { ...input.job, attempts };

      if (attempts >= safeMaxAttempts) {
        await client.rPush(
          deadLetterKey,
          serializeDeadLetteredDocumentReindexJob({
            job: failedJob,
            errorMessage: input.errorMessage,
            failedAt: now(),
          }),
        );
        return { action: "dead_lettered", attempts };
      }

      await client.rPush(queueKey, serializeDocumentReindexJob(failedJob));
      return { action: "requeued", attempts };
    },

    getDeadLetterCount() {
      return client.lLen(deadLetterKey);
    },
  };
}

export function serializeDocumentReindexJob(job: DocumentReindexJob): string {
  return JSON.stringify({
    ...job,
    enqueuedAt: job.enqueuedAt.toISOString(),
  });
}

export function parseDocumentReindexJob(payload: string): DocumentReindexJob {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw new Error("Invalid document reindex job JSON");
  }

  if (!isRecord(parsed)) {
    throw new Error("Invalid document reindex job payload");
  }

  const enqueuedAt = new Date(readString(parsed.enqueuedAt));
  const reason = parsed.reason;
  const parsedAttempts = readOptionalNonNegativeInteger(parsed.attempts);
  const attempts = parsedAttempts ?? 0;
  if (
    !isValidReason(reason) ||
    Number.isNaN(enqueuedAt.getTime()) ||
    readString(parsed.idempotencyKey).length === 0 ||
    readString(parsed.embeddingProfileId).length === 0 ||
    readString(parsed.documentSnapshotId).length === 0 ||
    parsedAttempts === null
  ) {
    throw new Error("Invalid document reindex job payload");
  }

  return {
    idempotencyKey: readString(parsed.idempotencyKey),
    embeddingProfileId: readString(parsed.embeddingProfileId),
    documentSnapshotId: readString(parsed.documentSnapshotId),
    reason,
    enqueuedAt,
    attempts,
  };
}

function serializeDeadLetteredDocumentReindexJob(input: {
  job: DocumentReindexJob;
  errorMessage: string;
  failedAt: Date;
}): string {
  return JSON.stringify({
    job: {
      ...input.job,
      enqueuedAt: input.job.enqueuedAt.toISOString(),
    },
    errorMessage: input.errorMessage,
    failedAt: input.failedAt.toISOString(),
  });
}

function readString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function readOptionalNonNegativeInteger(value: unknown): number | null | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    return null;
  }

  return value;
}

function isValidReason(value: unknown): value is DocumentReindexJob["reason"] {
  return value === "document_synced" || value === "manual_profile_reindex";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function sanitizeMaxAttempts(value: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error("maxAttempts must be a positive integer");
  }

  return value;
}
