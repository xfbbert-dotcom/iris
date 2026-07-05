import {
  MAX_DOCUMENT_REINDEX_IDEMPOTENCY_KEY_CHARS,
  MAX_DOCUMENT_REINDEX_JOB_ID_CHARS,
  MAX_DOCUMENT_REINDEX_QUEUE_LIMIT,
  createDocumentReindexIdempotencyKey,
  type DocumentReindexDeadLetter,
  type DocumentReindexJob,
  type DocumentReindexQueue,
  type FailedDocumentReindexJobInput,
  type FailedDocumentReindexJobResult,
  type ReplayDocumentReindexDeadLettersResult,
} from "./document-reindex-queue.js";
import { normalizeDeadLetterErrorMessage } from "../queues/dead-letter-error-message.js";

const DEFAULT_SEEN_KEY = "iris:reindex:documents:seen";
const DEFAULT_QUEUE_KEY = "iris:reindex:documents:queue";
const DEFAULT_PROCESSING_KEY = "iris:reindex:documents:processing";
const DEFAULT_DEAD_LETTER_KEY = "iris:reindex:documents:dlq";
const DEFAULT_MAX_ATTEMPTS = 3;

const ENQUEUE_SCRIPT = `
if redis.call("SADD", KEYS[1], ARGV[1]) == 1 then
  return redis.call("RPUSH", KEYS[2], ARGV[2])
end
return 0
`;

const DEQUEUE_SCRIPT = `
local payload = redis.call("LPOP", KEYS[1])
if payload then
  redis.call("RPUSH", KEYS[2], payload)
  return payload
end
return nil
`;

const RECOVER_PROCESSING_SCRIPT = `
local recovered = 0
local payload = redis.call("RPOP", KEYS[1])
while payload do
  redis.call("LPUSH", KEYS[2], payload)
  recovered = recovered + 1
  payload = redis.call("RPOP", KEYS[1])
end
return recovered
`;

const UPSERT_RETRY_SCRIPT = `
if redis.call("SADD", KEYS[1], ARGV[1]) == 1 then
  return redis.call("RPUSH", KEYS[2], ARGV[2])
end

local queued = redis.call("LRANGE", KEYS[2], 0, -1)
for index, payload in ipairs(queued) do
  local ok, decoded = pcall(cjson.decode, payload)
  if ok and decoded["idempotencyKey"] == ARGV[1] then
    redis.call("LSET", KEYS[2], index - 1, ARGV[2])
    return 1
  end
end

return redis.call("RPUSH", KEYS[2], ARGV[2])
`;

export type RedisDocumentReindexQueueClient = {
  eval(
    script: string,
    options: { keys: string[]; arguments: string[] },
  ): Promise<number | string | null>;
  rPush(key: string, value: string): Promise<number>;
  lPop(key: string): Promise<string | null>;
  lLen(key: string): Promise<number>;
  lRange(key: string, start: number, stop: number): Promise<string[]>;
  lRem(key: string, count: number, value: string): Promise<number>;
  sRem(key: string, member: string): Promise<number>;
};

export type RedisDocumentReindexQueueOptions = {
  client: RedisDocumentReindexQueueClient;
  seenKey?: string;
  queueKey?: string;
  processingKey?: string;
  deadLetterKey?: string;
  maxAttempts?: number;
  now?: () => Date;
  idGenerator?: () => string;
};

export function createRedisDocumentReindexQueue({
  client,
  seenKey = DEFAULT_SEEN_KEY,
  queueKey = DEFAULT_QUEUE_KEY,
  processingKey = DEFAULT_PROCESSING_KEY,
  deadLetterKey = DEFAULT_DEAD_LETTER_KEY,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  now = () => new Date(),
  idGenerator = defaultIdGenerator,
}: RedisDocumentReindexQueueOptions): DocumentReindexQueue {
  const safeMaxAttempts = sanitizeMaxAttempts(maxAttempts);

  const replayDeadLetter = async (
    id: string,
  ): Promise<"replayed" | "not_found" | "unsupported_legacy_item"> => {
    const found = await findDeadLetterByStoredId(client, deadLetterKey, id, now);
    if (found === undefined) {
      return id.startsWith("legacy:") ? "unsupported_legacy_item" : "not_found";
    }

    if (!("job" in found.deadLetter)) {
      return "unsupported_legacy_item";
    }

    await upsertRetryingSerializedJob(client, seenKey, queueKey, {
      ...found.deadLetter.job,
      attempts: 0,
    });
    await client.lRem(deadLetterKey, 1, found.payload);
    return "replayed";
  };

  const deleteDeadLetter = async (
    id: string,
  ): Promise<"deleted" | "not_found" | "unsupported_legacy_item"> => {
    const found = await findDeadLetterByStoredId(client, deadLetterKey, id, now);
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
      const jobs: DocumentReindexJob[] = [];

      await recoverProcessingJobsIfPresent(client, processingKey, queueKey);
      for (let index = 0; index < safeLimit; index += 1) {
        const payload = await dequeueSerializedJob(client, queueKey, processingKey);
        if (payload === null) {
          break;
        }

        try {
          const job = parseDocumentReindexJob(payload);
          jobs.push(job);
        } catch (error) {
          const idempotencyKey = readQueuedDocumentReindexIdempotencyKey(payload);
          await client.rPush(
            deadLetterKey,
            JSON.stringify({
              id: idGenerator(),
              rawPayload: payload,
              errorMessage: normalizeDeadLetterErrorMessage(
                error instanceof Error ? error.message : String(error),
              ),
              failedAt: now().toISOString(),
            }),
          );
          await client.lRem(processingKey, 1, payload);
          if (idempotencyKey !== undefined) {
            await client.sRem(seenKey, idempotencyKey);
          }
        }
      }

      return jobs;
    },

    async handleProcessedJob(job: DocumentReindexJob): Promise<void> {
      const payload = serializeDocumentReindexJob(job);
      const normalizedJob = parseDocumentReindexJob(payload);
      await client.lRem(processingKey, 1, payload);
      await client.sRem(seenKey, normalizedJob.idempotencyKey);
    },

    getPendingCount() {
      return client.lLen(queueKey);
    },

    async handleFailedJob(
      input: FailedDocumentReindexJobInput,
    ): Promise<FailedDocumentReindexJobResult> {
      const attempts = input.job.attempts + 1;
      const failedJob = { ...input.job, attempts };
      const originalPayload = serializeDocumentReindexJob(input.job);

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
        await client.lRem(processingKey, 1, originalPayload);
        await client.sRem(seenKey, parseDocumentReindexJob(originalPayload).idempotencyKey);
        return { action: "dead_lettered", attempts };
      }

      await upsertRetryingSerializedJob(client, seenKey, queueKey, failedJob);
      await client.lRem(processingKey, 1, originalPayload);
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
      return payloads.map((payload, index) => parseDeadLetterPayload(payload, index, now).deadLetter);
    },

    replayDeadLetter,

    deleteDeadLetter,

    async replayDeadLetters(input): Promise<ReplayDocumentReindexDeadLettersResult> {
      const result: ReplayDocumentReindexDeadLettersResult = {
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
  client: RedisDocumentReindexQueueClient,
  seenKey: string,
  queueKey: string,
  job: DocumentReindexJob,
): Promise<void> {
  const payload = serializeDocumentReindexJob(job);
  const normalizedJob = parseDocumentReindexJob(payload);
  await client.eval(ENQUEUE_SCRIPT, {
    keys: [seenKey, queueKey],
    arguments: [normalizedJob.idempotencyKey, payload],
  });
}

async function recoverProcessingJobsIfPresent(
  client: RedisDocumentReindexQueueClient,
  processingKey: string,
  queueKey: string,
): Promise<void> {
  const processingCount = await client.lLen(processingKey);
  if (typeof processingCount !== "number" || processingCount <= 0) {
    return;
  }

  await client.eval(RECOVER_PROCESSING_SCRIPT, {
    keys: [processingKey, queueKey],
    arguments: [],
  });
}

async function dequeueSerializedJob(
  client: RedisDocumentReindexQueueClient,
  queueKey: string,
  processingKey: string,
): Promise<string | null> {
  const result = await client.eval(DEQUEUE_SCRIPT, {
    keys: [queueKey, processingKey],
    arguments: [],
  });

  return typeof result === "string" ? result : null;
}

async function upsertRetryingSerializedJob(
  client: RedisDocumentReindexQueueClient,
  seenKey: string,
  queueKey: string,
  job: DocumentReindexJob,
): Promise<void> {
  const payload = serializeDocumentReindexJob(job);
  const normalizedJob = parseDocumentReindexJob(payload);
  await client.eval(UPSERT_RETRY_SCRIPT, {
    keys: [seenKey, queueKey],
    arguments: [normalizedJob.idempotencyKey, payload],
  });
}

export function serializeDocumentReindexJob(job: DocumentReindexJob): string {
  return JSON.stringify(serializeDocumentReindexJobPayload(normalizeDocumentReindexJob(job)));
}

function normalizeDocumentReindexJob(job: DocumentReindexJob): DocumentReindexJob {
  return parseDocumentReindexJob(JSON.stringify(serializeDocumentReindexJobPayload(job)));
}

function serializeDocumentReindexJobPayload(job: DocumentReindexJob): Record<string, unknown> {
  return {
    ...job,
    enqueuedAt: job.enqueuedAt.toISOString(),
  };
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
  const idempotencyKey = readString(parsed.idempotencyKey);
  const embeddingProfileId = readString(parsed.embeddingProfileId);
  const documentSnapshotId = readString(parsed.documentSnapshotId);
  const reason = parsed.reason;
  const parsedAttempts = readOptionalNonNegativeInteger(parsed.attempts);
  const attempts = parsedAttempts ?? 0;
  if (
    !isValidReason(reason) ||
    Number.isNaN(enqueuedAt.getTime()) ||
    idempotencyKey.length === 0 ||
    idempotencyKey.length > MAX_DOCUMENT_REINDEX_IDEMPOTENCY_KEY_CHARS ||
    embeddingProfileId.length === 0 ||
    embeddingProfileId.length > MAX_DOCUMENT_REINDEX_JOB_ID_CHARS ||
    documentSnapshotId.length === 0 ||
    documentSnapshotId.length > MAX_DOCUMENT_REINDEX_JOB_ID_CHARS ||
    idempotencyKey !==
      createDocumentReindexIdempotencyKey({
        embeddingProfileId,
        documentSnapshotId,
      }) ||
    parsedAttempts === null
  ) {
    throw new Error("Invalid document reindex job payload");
  }

  return {
    idempotencyKey,
    embeddingProfileId,
    documentSnapshotId,
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
  const job = normalizeDocumentReindexJob(input.job);
  return JSON.stringify({
    id: input.id,
    job: serializeDocumentReindexJobPayload(job),
    errorMessage: normalizeDeadLetterErrorMessage(input.errorMessage),
    failedAt: input.failedAt.toISOString(),
  });
}

type ParsedDeadLetterPayload = {
  payload: string;
  deadLetter: DocumentReindexDeadLetter;
  storedId?: string;
};

function parseDeadLetterPayload(
  payload: string,
  index: number,
  now: () => Date,
): ParsedDeadLetterPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return createInvalidDeadLetterDiagnostic({
      payload,
      index,
      errorMessage: "Invalid document reindex dead letter JSON",
      failedAt: now(),
    });
  }

  if (!isRecord(parsed)) {
    return createInvalidDeadLetterDiagnostic({
      payload,
      index,
      errorMessage: "Invalid document reindex dead letter payload",
      failedAt: now(),
    });
  }

  const failedAt = new Date(readString(parsed.failedAt));
  const errorMessage = readString(parsed.errorMessage);
  const storedId = readString(parsed.id) || undefined;
  if (Number.isNaN(failedAt.getTime()) || errorMessage.length === 0) {
    return createInvalidDeadLetterDiagnostic({
      payload,
      index,
      storedId,
      errorMessage: "Invalid document reindex dead letter payload",
      failedAt: now(),
    });
  }

  if (!isRecord(parsed.job)) {
    const rawPayload = readRawPayload(parsed.rawPayload);
    if (rawPayload === undefined) {
      return createInvalidDeadLetterDiagnostic({
        payload,
        index,
        storedId,
        errorMessage: "Invalid document reindex dead letter payload",
        failedAt,
      });
    }

    return {
      payload,
      storedId,
      deadLetter: {
        id: storedId ?? createLegacyDeadLetterId(payload, index),
        rawPayload,
        errorMessage: normalizeDeadLetterErrorMessage(errorMessage),
        failedAt,
        replayable: false,
      },
    };
  }

  let job: DocumentReindexJob;
  try {
    job = parseDocumentReindexJob(JSON.stringify(parsed.job));
  } catch (error) {
    return createInvalidDeadLetterDiagnostic({
      payload,
      index,
      storedId,
      errorMessage: normalizeDeadLetterErrorMessage(
        error instanceof Error ? error.message : String(error),
      ),
      failedAt,
    });
  }

  return {
    payload,
    storedId,
    deadLetter: {
      id: storedId ?? createLegacyDeadLetterId(payload, index),
      job,
      errorMessage: normalizeDeadLetterErrorMessage(errorMessage),
      failedAt,
      replayable: storedId !== undefined,
    },
  };
}

function createInvalidDeadLetterDiagnostic(input: {
  payload: string;
  index: number;
  storedId?: string;
  errorMessage: string;
  failedAt: Date;
}): ParsedDeadLetterPayload {
  return {
    payload: input.payload,
    storedId: input.storedId,
    deadLetter: {
      id: input.storedId ?? createLegacyDeadLetterId(input.payload, input.index),
      rawPayload: input.payload,
      errorMessage: normalizeDeadLetterErrorMessage(input.errorMessage),
      failedAt: input.failedAt,
      replayable: false,
    },
  };
}

async function findDeadLetterByStoredId(
  client: RedisDocumentReindexQueueClient,
  deadLetterKey: string,
  id: string,
  now: () => Date,
): Promise<ParsedDeadLetterPayload | undefined> {
  const payloads = await client.lRange(deadLetterKey, 0, -1);

  for (const [index, payload] of payloads.entries()) {
    const parsed = parseDeadLetterPayload(payload, index, now);
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

function readQueuedDocumentReindexIdempotencyKey(payload: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return undefined;
  }

  if (!isRecord(parsed)) {
    return undefined;
  }

  const idempotencyKey = readString(parsed.idempotencyKey);
  const embeddingProfileId = readString(parsed.embeddingProfileId);
  const documentSnapshotId = readString(parsed.documentSnapshotId);
  if (
    idempotencyKey.length === 0 ||
    idempotencyKey.length > MAX_DOCUMENT_REINDEX_IDEMPOTENCY_KEY_CHARS ||
    embeddingProfileId.length === 0 ||
    documentSnapshotId.length === 0
  ) {
    return undefined;
  }

  let expectedIdempotencyKey: string;
  try {
    expectedIdempotencyKey = createDocumentReindexIdempotencyKey({
      embeddingProfileId,
      documentSnapshotId,
    });
  } catch {
    return undefined;
  }

  return idempotencyKey === expectedIdempotencyKey ? idempotencyKey : undefined;
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
  if (!Number.isSafeInteger(value)) {
    throw new Error("maxAttempts must be a positive safe integer");
  }

  return value;
}

function sanitizeLimit(value: number): number {
  if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) {
    throw new Error("document reindex queue limit must be a finite safe-magnitude number");
  }

  return Math.min(MAX_DOCUMENT_REINDEX_QUEUE_LIMIT, Math.max(0, Math.floor(value)));
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
