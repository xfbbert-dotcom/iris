import type { DocumentSyncJob, DocumentSyncQueue } from "./document-sync-queue.js";

const DEFAULT_SEEN_KEY = "iris:documents:sync:seen";
const DEFAULT_QUEUE_KEY = "iris:documents:sync:queue";

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
  lPop(key: string): Promise<string | null>;
  lLen(key: string): Promise<number>;
};

export type RedisDocumentSyncQueueOptions = {
  client: RedisDocumentSyncQueueClient;
  seenKey?: string;
  queueKey?: string;
};

export function createRedisDocumentSyncQueue({
  client,
  seenKey = DEFAULT_SEEN_KEY,
  queueKey = DEFAULT_QUEUE_KEY,
}: RedisDocumentSyncQueueOptions): DocumentSyncQueue {
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
  };
}

export function serializeDocumentSyncJob(job: DocumentSyncJob): string {
  return JSON.stringify({
    ...job,
    enqueuedAt: job.enqueuedAt.toISOString(),
  });
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
