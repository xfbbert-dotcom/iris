import type {
  DocumentReindexDeadLetter,
  DocumentReindexJob,
  DocumentReindexQueue,
  FailedDocumentReindexJobInput,
  FailedDocumentReindexJobResult,
  ReplayDocumentReindexDeadLettersResult,
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
  lRange(key: string, start: number, stop: number): Promise<string[]>;
  lRem(key: string, count: number, value: string): Promise<number>;
};

export type RedisDocumentReindexQueueOptions = {
  client: RedisDocumentReindexQueueClient;
  seenKey?: string;
  queueKey?: string;
  deadLetterKey?: string;
  maxAttempts?: number;
  now?: () => Date;
  idGenerator?: () => string;
};

export function createRedisDocumentReindexQueue({
  client,
  seenKey = DEFAULT_SEEN_KEY,
  queueKey = DEFAULT_QUEUE_KEY,
  deadLetterKey = DEFAULT_DEAD_LETTER_KEY,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  now = () => new Date(),
  idGenerator = defaultIdGenerator,
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
      const safeLimit = sanitizeLimit(limit);
      const jobs: DocumentReindexJob[] = [];

      for (let index = 0; index < safeLimit; index += 1) {
        const payload = await client.lPop(queueKey);
        if (payload === null) {
          break;
        }

        try {
          jobs.push(parseDocumentReindexJob(payload));
        } catch (error) {
          await client.rPush(
            deadLetterKey,
            JSON.stringify({
              id: idGenerator(),
              rawPayload: payload,
              errorMessage: error instanceof Error ? error.message : String(error),
              failedAt: now().toISOString(),
            }),
          );
        }
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
            id: idGenerator(),
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

    async listDeadLetters(input) {
      const safeLimit = sanitizeLimit(input.limit);
      if (safeLimit === 0) {
        return [];
      }

      const payloads = await client.lRange(deadLetterKey, 0, safeLimit - 1);
      return payloads.map((payload, index) => parseDeadLetterPayload(payload, index).deadLetter);
    },

    async replayDeadLetter(id) {
      const found = await findDeadLetterByStoredId(client, deadLetterKey, id);
      if (found === undefined) {
        return id.startsWith("legacy:") ? "unsupported_legacy_item" : "not_found";
      }

      if (!("job" in found.deadLetter)) {
        return "unsupported_legacy_item";
      }

      await client.lRem(deadLetterKey, 1, found.payload);
      await client.rPush(
        queueKey,
        serializeDocumentReindexJob({ ...found.deadLetter.job, attempts: 0 }),
      );
      return "replayed";
    },

    async deleteDeadLetter(id) {
      const found = await findDeadLetterByStoredId(client, deadLetterKey, id);
      if (found === undefined) {
        return id.startsWith("legacy:") ? "unsupported_legacy_item" : "not_found";
      }

      await client.lRem(deadLetterKey, 1, found.payload);
      return "deleted";
    },

    async replayDeadLetters(input): Promise<ReplayDocumentReindexDeadLettersResult> {
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
  id: string;
  job: DocumentReindexJob;
  errorMessage: string;
  failedAt: Date;
}): string {
  return JSON.stringify({
    id: input.id,
    job: {
      ...input.job,
      enqueuedAt: input.job.enqueuedAt.toISOString(),
    },
    errorMessage: input.errorMessage,
    failedAt: input.failedAt.toISOString(),
  });
}

type ParsedDeadLetterPayload = {
  payload: string;
  deadLetter: DocumentReindexDeadLetter;
  storedId?: string;
};

function parseDeadLetterPayload(payload: string, index: number): ParsedDeadLetterPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw new Error("Invalid document reindex dead letter JSON");
  }

  if (!isRecord(parsed)) {
    throw new Error("Invalid document reindex dead letter payload");
  }

  const failedAt = new Date(readString(parsed.failedAt));
  const errorMessage = readString(parsed.errorMessage);
  const storedId = readString(parsed.id) || undefined;
  if (Number.isNaN(failedAt.getTime()) || errorMessage.length === 0) {
    throw new Error("Invalid document reindex dead letter payload");
  }

  if (!isRecord(parsed.job)) {
    const rawPayload = readRawPayload(parsed.rawPayload);
    if (rawPayload === undefined) {
      throw new Error("Invalid document reindex dead letter payload");
    }

    return {
      payload,
      storedId,
      deadLetter: {
        id: storedId ?? createLegacyDeadLetterId(payload, index),
        rawPayload,
        errorMessage,
        failedAt,
        replayable: false,
      },
    };
  }

  const job = parseDocumentReindexJob(JSON.stringify(parsed.job));
  return {
    payload,
    storedId,
    deadLetter: {
      id: storedId ?? createLegacyDeadLetterId(payload, index),
      job,
      errorMessage,
      failedAt,
      replayable: storedId !== undefined,
    },
  };
}

async function findDeadLetterByStoredId(
  client: RedisDocumentReindexQueueClient,
  deadLetterKey: string,
  id: string,
): Promise<ParsedDeadLetterPayload | undefined> {
  const payloads = await client.lRange(deadLetterKey, 0, -1);

  for (const [index, payload] of payloads.entries()) {
    const parsed = parseDeadLetterPayload(payload, index);
    if (parsed.storedId === id) {
      return parsed;
    }
  }

  return undefined;
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readRawPayload(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
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

function sanitizeLimit(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.floor(value));
}

function defaultIdGenerator(): string {
  return `dlq_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

function createLegacyDeadLetterId(payload: string, index: number): string {
  let hash = 0;
  for (let cursor = 0; cursor < payload.length; cursor += 1) {
    hash = (hash * 31 + payload.charCodeAt(cursor)) >>> 0;
  }

  return `legacy:${index}:${hash.toString(16)}`;
}
