import type {
  DocumentSyncDeadLetter,
  DocumentSyncJob,
  DocumentSyncQueue,
  FailedDocumentSyncJobInput,
  FailedDocumentSyncJobResult,
  ReplayDocumentSyncDeadLettersResult,
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
  lRange(key: string, start: number, stop: number): Promise<string[]>;
  lRem(key: string, count: number, value: string): Promise<number>;
  sRem(key: string, member: string): Promise<number>;
};

export type RedisDocumentSyncQueueOptions = {
  client: RedisDocumentSyncQueueClient;
  seenKey?: string;
  queueKey?: string;
  deadLetterKey?: string;
  maxAttempts?: number;
  now?: () => Date;
  idGenerator?: () => string;
};

export function createRedisDocumentSyncQueue({
  client,
  seenKey = DEFAULT_SEEN_KEY,
  queueKey = DEFAULT_QUEUE_KEY,
  deadLetterKey = DEFAULT_DEAD_LETTER_KEY,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  now = () => new Date(),
  idGenerator = defaultIdGenerator,
}: RedisDocumentSyncQueueOptions): DocumentSyncQueue {
  const safeMaxAttempts = sanitizeMaxAttempts(maxAttempts);

  const replayDeadLetter = async (
    id: string,
  ): Promise<"replayed" | "not_found" | "unsupported_legacy_item"> => {
    const found = await findDeadLetterByStoredId(client, deadLetterKey, id);
    if (found === undefined) {
      return id.startsWith("legacy:") ? "unsupported_legacy_item" : "not_found";
    }

    if (!("job" in found.deadLetter)) {
      return "unsupported_legacy_item";
    }

    await client.lRem(deadLetterKey, 1, found.payload);
    await enqueueSerializedJob(client, seenKey, queueKey, {
      ...found.deadLetter.job,
      attempts: 0,
    });
    return "replayed";
  };

  const deleteDeadLetter = async (
    id: string,
  ): Promise<"deleted" | "not_found" | "unsupported_legacy_item"> => {
    const found = await findDeadLetterByStoredId(client, deadLetterKey, id);
    if (found === undefined) {
      return id.startsWith("legacy:") ? "unsupported_legacy_item" : "not_found";
    }

    await client.lRem(deadLetterKey, 1, found.payload);
    return "deleted";
  };

  return {
    async enqueue(job) {
      await enqueueSerializedJob(client, seenKey, queueKey, job);
    },

    async dequeueBatch(limit) {
      const safeLimit = sanitizeLimit(limit);
      const jobs: DocumentSyncJob[] = [];

      for (let index = 0; index < safeLimit; index += 1) {
        const payload = await client.lPop(queueKey);
        if (payload === null) {
          break;
        }

        try {
          const job = parseDocumentSyncJob(payload);
          await client.sRem(seenKey, job.idempotencyKey);
          jobs.push(job);
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
      input: FailedDocumentSyncJobInput,
    ): Promise<FailedDocumentSyncJobResult> {
      const attempts = input.job.attempts + 1;
      const failedJob = { ...input.job, attempts };

      if (attempts >= safeMaxAttempts) {
        await client.rPush(
          deadLetterKey,
          serializeDeadLetteredDocumentSyncJob({
            id: idGenerator(),
            job: failedJob,
            errorMessage: input.errorMessage,
            failedAt: now(),
          }),
        );
        return { action: "dead_lettered", attempts };
      }

      await enqueueSerializedJob(client, seenKey, queueKey, failedJob);
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

async function enqueueSerializedJob(
  client: RedisDocumentSyncQueueClient,
  seenKey: string,
  queueKey: string,
  job: DocumentSyncJob,
): Promise<void> {
  await client.eval(ENQUEUE_SCRIPT, {
    keys: [seenKey, queueKey],
    arguments: [job.idempotencyKey, serializeDocumentSyncJob(job)],
  });
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
    !isValidReason(reason) ||
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
  return typeof value === "string" ? value.trim() : "";
}

function readRawPayload(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readOptionalNonNegativeInteger(value: unknown): number | null | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    return null;
  }

  return value;
}

function isValidReason(value: unknown): value is DocumentSyncJob["reason"] {
  return value === "discovered_group_document" || value === "manual_source_sync";
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

function serializeDeadLetteredDocumentSyncJob(input: {
  id: string;
  job: DocumentSyncJob;
  errorMessage: string;
  failedAt: Date;
}): string {
  return JSON.stringify({
    id: input.id,
    job: serializeDocumentSyncJobPayload(input.job),
    errorMessage: input.errorMessage,
    failedAt: input.failedAt.toISOString(),
  });
}

type ParsedDeadLetterPayload = {
  payload: string;
  deadLetter: DocumentSyncDeadLetter;
  storedId?: string;
};

function parseDeadLetterPayload(payload: string, index: number): ParsedDeadLetterPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw new Error("Invalid document sync dead letter JSON");
  }

  if (!isRecord(parsed)) {
    throw new Error("Invalid document sync dead letter payload");
  }

  const failedAt = new Date(readString(parsed.failedAt));
  const errorMessage = readString(parsed.errorMessage);
  const storedId = readString(parsed.id) || undefined;
  if (Number.isNaN(failedAt.getTime()) || errorMessage.length === 0) {
    throw new Error("Invalid document sync dead letter payload");
  }

  if (!isRecord(parsed.job)) {
    const rawPayload = readRawPayload(parsed.rawPayload);
    if (rawPayload === undefined) {
      throw new Error("Invalid document sync dead letter payload");
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

  const job = parseDocumentSyncJob(JSON.stringify(parsed.job));
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
  client: RedisDocumentSyncQueueClient,
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

function sanitizeMaxAttempts(value: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error("maxAttempts must be a positive integer");
  }
  if (!Number.isSafeInteger(value)) {
    throw new Error("maxAttempts must be a positive safe integer");
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
