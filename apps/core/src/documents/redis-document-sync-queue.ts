import type {
  DocumentSyncJob,
  DocumentSyncQueue,
  FailedDocumentSyncJobInput,
  FailedDocumentSyncJobResult,
} from "./document-sync-queue.js";

const DEFAULT_SEEN_KEY = "iris:documents:sync:seen";
const DEFAULT_QUEUE_KEY = "iris:documents:sync:queue";
const DEFAULT_DEAD_LETTER_KEY = "iris:documents:sync:dlq";
const DEFAULT_MAX_ATTEMPTS = 3;

const ENQUEUE_SCRIPT = `
if redis.call("SADD", KEYS[1], ARGV[1]) == 1 then
  return redis.call("RPUSH", KEYS[2], ARGV[2])
end
return 0
`;

export type RedisDocumentSyncQueueClient = {
  eval(
    script: string,
    options: { keys: string[]; arguments: string[] },
  ): Promise<number | string>;
  rPush(key: string, value: string): Promise<number>;
  lPop(key: string): Promise<string | null>;
  lLen(key: string): Promise<number>;
};

export type RedisDocumentSyncQueueOptions = {
  client: RedisDocumentSyncQueueClient;
  seenKey?: string;
  queueKey?: string;
  deadLetterKey?: string;
  maxAttempts?: number;
  now?: () => Date;
};

export function createRedisDocumentSyncQueue({
  client,
  seenKey = DEFAULT_SEEN_KEY,
  queueKey = DEFAULT_QUEUE_KEY,
  deadLetterKey = DEFAULT_DEAD_LETTER_KEY,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  now = () => new Date(),
}: RedisDocumentSyncQueueOptions): DocumentSyncQueue {
  const safeMaxAttempts = sanitizeMaxAttempts(maxAttempts);

  return {
    async enqueue(job) {
      await client.eval(ENQUEUE_SCRIPT, {
        keys: [seenKey, queueKey],
        arguments: [job.idempotencyKey, serializeDocumentSyncJob(job)],
      });
    },

    async dequeueBatch(limit) {
      const safeLimit = Math.max(0, Math.floor(limit));
      const jobs: DocumentSyncJob[] = [];

      for (let index = 0; index < safeLimit; index += 1) {
        const payload = await client.lPop(queueKey);
        if (payload === null) {
          break;
        }

        jobs.push(parseDocumentSyncJob(payload));
      }

      return jobs;
    },

    getPendingCount() {
      return client.lLen(queueKey);
    },

    async handleFailedJob(
      input: FailedDocumentSyncJobInput,
    ): Promise<FailedDocumentSyncJobResult> {
      const attempts = input.job.attempts + 1;
      const failedJob = { ...input.job, attempts };

      if (attempts >= safeMaxAttempts) {
        await client.rPush(
          deadLetterKey,
          JSON.stringify({
            job: serializeDocumentSyncJobPayload(failedJob),
            errorMessage: input.errorMessage,
            failedAt: now().toISOString(),
          }),
        );
        return { action: "dead_lettered", attempts };
      }

      await client.rPush(queueKey, serializeDocumentSyncJob(failedJob));
      return { action: "requeued", attempts };
    },

    getDeadLetterCount() {
      return client.lLen(deadLetterKey);
    },
  };
}

export function serializeDocumentSyncJob(job: DocumentSyncJob): string {
  return JSON.stringify(serializeDocumentSyncJobPayload(job));
}

export function parseDocumentSyncJob(payload: string): DocumentSyncJob {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw new Error("Invalid document sync job JSON");
  }

  if (!isRecord(parsed)) {
    throw new Error("Invalid document sync job payload");
  }

  const enqueuedAt = new Date(readString(parsed.enqueuedAt));
  const reason = parsed.reason;
  const parsedAttempts = readOptionalNonNegativeInteger(parsed.attempts);
  const attempts = parsedAttempts ?? 0;

  if (
    readString(parsed.idempotencyKey).length === 0 ||
    readString(parsed.documentSourceId).length === 0 ||
    reason !== "discovered_group_document" ||
    Number.isNaN(enqueuedAt.getTime()) ||
    parsedAttempts === null
  ) {
    throw new Error("Invalid document sync job payload");
  }

  return {
    idempotencyKey: readString(parsed.idempotencyKey),
    documentSourceId: readString(parsed.documentSourceId),
    reason,
    enqueuedAt,
    attempts,
  };
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function serializeDocumentSyncJobPayload(job: DocumentSyncJob): Record<string, unknown> {
  return {
    ...job,
    enqueuedAt: job.enqueuedAt.toISOString(),
  };
}

function sanitizeMaxAttempts(value: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error("maxAttempts must be a positive integer");
  }

  return value;
}
