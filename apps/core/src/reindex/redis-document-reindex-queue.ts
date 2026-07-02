import type { DocumentReindexJob, DocumentReindexQueue } from "./document-reindex-queue.js";

const DEFAULT_SEEN_KEY = "iris:reindex:documents:seen";
const DEFAULT_QUEUE_KEY = "iris:reindex:documents:queue";

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
  lPop(key: string): Promise<string | null>;
  lLen(key: string): Promise<number>;
};

export type RedisDocumentReindexQueueOptions = {
  client: RedisDocumentReindexQueueClient;
  seenKey?: string;
  queueKey?: string;
};

export function createRedisDocumentReindexQueue({
  client,
  seenKey = DEFAULT_SEEN_KEY,
  queueKey = DEFAULT_QUEUE_KEY,
}: RedisDocumentReindexQueueOptions): DocumentReindexQueue {
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
  if (
    !isValidReason(reason) ||
    Number.isNaN(enqueuedAt.getTime()) ||
    readString(parsed.idempotencyKey).length === 0 ||
    readString(parsed.embeddingProfileId).length === 0 ||
    readString(parsed.documentSnapshotId).length === 0
  ) {
    throw new Error("Invalid document reindex job payload");
  }

  return {
    idempotencyKey: readString(parsed.idempotencyKey),
    embeddingProfileId: readString(parsed.embeddingProfileId),
    documentSnapshotId: readString(parsed.documentSnapshotId),
    reason,
    enqueuedAt,
  };
}

function readString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isValidReason(value: unknown): value is DocumentReindexJob["reason"] {
  return value === "document_synced" || value === "manual_profile_reindex";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
