import { createHash, randomUUID } from "node:crypto";

import { normalizeDeadLetterErrorMessage } from "../queues/dead-letter-error-message.js";
import {
  MAX_MEMORY_EXTRACTION_IDEMPOTENCY_KEY_CHARS,
  MAX_MEMORY_EXTRACTION_IDENTIFIER_CHARS,
  MAX_MEMORY_EXTRACTION_QUEUE_LIMIT,
  MEMORY_EXTRACTION_SCHEMA_VERSION,
  createMemoryExtractionIdempotencyKey,
  normalizeMemoryExtractionIdentifier,
  requireValidMemoryExtractionDate,
  type MemoryExtractionDeadLetter,
  type MemoryExtractionJob,
  type MemoryExtractionQueue,
  type ReplayMemoryExtractionDeadLettersResult,
} from "./memory-extraction-queue.js";

const DEFAULT_SEEN_KEY = "iris:memory:extraction:seen";
const DEFAULT_READY_KEY = "iris:memory:extraction:ready";
const DEFAULT_DELAYED_KEY = "iris:memory:extraction:delayed";
const DEFAULT_PROCESSING_KEY = "iris:memory:extraction:processing";
const DEFAULT_COOLDOWN_KEY = "iris:memory:extraction:cooldown";
const DEFAULT_DEAD_LETTER_KEY = "iris:memory:extraction:dlq";
const DEFAULT_MAX_ATTEMPTS = 5;

const ENQUEUE_SCRIPT = `
-- memory-extraction:enqueue
local function has_id(payload, idempotency_key)
  local ok, decoded = pcall(cjson.decode, payload)
  return ok and decoded["idempotencyKey"] == idempotency_key
end

if redis.call("SISMEMBER", KEYS[1], ARGV[1]) == 1 then
  local ready = redis.call("LRANGE", KEYS[2], 0, -1)
  for _, payload in ipairs(ready) do
    if has_id(payload, ARGV[1]) then return 0 end
  end
  local delayed = redis.call("ZRANGE", KEYS[3], 0, -1)
  for _, payload in ipairs(delayed) do
    if has_id(payload, ARGV[1]) then return 0 end
  end
  local processing = redis.call("LRANGE", KEYS[4], 0, -1)
  for _, payload in ipairs(processing) do
    if has_id(payload, ARGV[1]) then return 0 end
  end
  redis.call("RPUSH", KEYS[2], ARGV[2])
  return 1
end

redis.call("RPUSH", KEYS[2], ARGV[2])
redis.call("SADD", KEYS[1], ARGV[1])
return 1
`;

const RECOVER_PROCESSING_SCRIPT = `
-- memory-extraction:recover-processing
local recovered = 0
local payload = redis.call("RPOP", KEYS[1])
while payload do
  redis.call("LPUSH", KEYS[2], payload)
  recovered = recovered + 1
  payload = redis.call("RPOP", KEYS[1])
end
return recovered
`;

const PROMOTE_DUE_SCRIPT = `
-- memory-extraction:promote-due
local due = redis.call(
  "ZRANGEBYSCORE", KEYS[1], "-inf", ARGV[1], "LIMIT", 0, ARGV[2]
)
for _, payload in ipairs(due) do
  if redis.call("ZREM", KEYS[1], payload) == 1 then
    redis.call("RPUSH", KEYS[2], payload)
  end
end
return #due
`;

const DEQUEUE_SCRIPT = `
-- memory-extraction:dequeue
local payload = redis.call("LPOP", KEYS[1])
if payload then
  redis.call("RPUSH", KEYS[2], payload)
  return payload
end
return nil
`;

const ACK_PROCESSED_SCRIPT = `
-- memory-extraction:ack-processed
if redis.call("LREM", KEYS[1], 1, ARGV[1]) > 0 then
  redis.call("SREM", KEYS[2], ARGV[2])
  return 1
end
return 0
`;

const ACK_RETRY_SCRIPT = `
-- memory-extraction:ack-retry
local processing = redis.call("LRANGE", KEYS[4], 0, -1)
local found = false
for _, payload in ipairs(processing) do
  if payload == ARGV[3] then found = true break end
end
if not found then return 0 end

local function has_id(payload)
  local ok, decoded = pcall(cjson.decode, payload)
  return ok and decoded["idempotencyKey"] == ARGV[1]
end

local ready = redis.call("LRANGE", KEYS[2], 0, -1)
for _, payload in ipairs(ready) do
  if has_id(payload) then redis.call("LREM", KEYS[2], 0, payload) end
end
local delayed = redis.call("ZRANGE", KEYS[3], 0, -1)
for _, payload in ipairs(delayed) do
  if has_id(payload) then redis.call("ZREM", KEYS[3], payload) end
end

if ARGV[5] == "delayed" then
  redis.call("ZADD", KEYS[3], ARGV[4], ARGV[2])
else
  redis.call("RPUSH", KEYS[2], ARGV[2])
end
redis.call("SADD", KEYS[1], ARGV[1])
redis.call("LREM", KEYS[4], 1, ARGV[3])
return 1
`;

const ACK_DEAD_LETTER_SCRIPT = `
-- memory-extraction:ack-dead-letter
local processing = redis.call("LRANGE", KEYS[2], 0, -1)
local found = false
for _, payload in ipairs(processing) do
  if payload == ARGV[2] then found = true break end
end
if not found then return 0 end

redis.call("RPUSH", KEYS[1], ARGV[1])
if ARGV[3] ~= "" then
  local function has_id(payload)
    local ok, decoded = pcall(cjson.decode, payload)
    return ok and decoded["idempotencyKey"] == ARGV[3]
  end
  local ready = redis.call("LRANGE", KEYS[4], 0, -1)
  for _, payload in ipairs(ready) do
    if has_id(payload) then redis.call("LREM", KEYS[4], 0, payload) end
  end
  local delayed = redis.call("ZRANGE", KEYS[5], 0, -1)
  for _, payload in ipairs(delayed) do
    if has_id(payload) then redis.call("ZREM", KEYS[5], payload) end
  end
end
redis.call("LREM", KEYS[2], 1, ARGV[2])
if ARGV[3] ~= "" then redis.call("SREM", KEYS[3], ARGV[3]) end
return 1
`;

const REPLAY_DEAD_LETTER_SCRIPT = `
-- memory-extraction:replay-dead-letter
local dead_letters = redis.call("LRANGE", KEYS[5], 0, -1)
local found = false
for _, payload in ipairs(dead_letters) do
  if payload == ARGV[3] then found = true break end
end
if not found then return 0 end

local function has_id(payload)
  local ok, decoded = pcall(cjson.decode, payload)
  return ok and decoded["idempotencyKey"] == ARGV[1]
end

local processing = redis.call("LRANGE", KEYS[4], 0, -1)
for _, payload in ipairs(processing) do
  if has_id(payload) then
    redis.call("LREM", KEYS[5], 1, ARGV[3])
    return 1
  end
end

local ready = redis.call("LRANGE", KEYS[2], 0, -1)
for _, payload in ipairs(ready) do
  if has_id(payload) then redis.call("LREM", KEYS[2], 0, payload) end
end
local delayed = redis.call("ZRANGE", KEYS[3], 0, -1)
for _, payload in ipairs(delayed) do
  if has_id(payload) then redis.call("ZREM", KEYS[3], payload) end
end

redis.call("RPUSH", KEYS[2], ARGV[2])
redis.call("SADD", KEYS[1], ARGV[1])
redis.call("LREM", KEYS[5], 1, ARGV[3])
return 1
`;

const DELETE_DEAD_LETTER_SCRIPT = `
-- memory-extraction:delete-dead-letter
return redis.call("LREM", KEYS[1], 1, ARGV[1])
`;

const SET_COOLDOWN_SCRIPT = `
-- memory-extraction:set-cooldown
local current = tonumber(redis.call("GET", KEYS[1]))
local candidate = tonumber(ARGV[1])
if current == nil or candidate > current then
  redis.call("SET", KEYS[1], ARGV[1])
  return 1
end
return 0
`;

export type RedisMemoryExtractionQueueClient = {
  eval(
    script: string,
    options: { keys: string[]; arguments: string[] },
  ): Promise<number | string | null>;
  lLen(key: string): Promise<number>;
  lRange(key: string, start: number, stop: number): Promise<string[]>;
  zCard(key: string): Promise<number>;
  get(key: string): Promise<string | null>;
};

export type RedisMemoryExtractionQueueOptions = {
  client: RedisMemoryExtractionQueueClient;
  seenKey?: string;
  readyKey?: string;
  delayedKey?: string;
  processingKey?: string;
  cooldownKey?: string;
  deadLetterKey?: string;
  maxAttempts?: number;
  now?: () => Date;
  idGenerator?: () => string;
};

export function createRedisMemoryExtractionQueue({
  client,
  seenKey = DEFAULT_SEEN_KEY,
  readyKey = DEFAULT_READY_KEY,
  delayedKey = DEFAULT_DELAYED_KEY,
  processingKey = DEFAULT_PROCESSING_KEY,
  cooldownKey = DEFAULT_COOLDOWN_KEY,
  deadLetterKey = DEFAULT_DEAD_LETTER_KEY,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  now = () => new Date(),
  idGenerator = randomUUID,
}: RedisMemoryExtractionQueueOptions): MemoryExtractionQueue {
  const safeMaxAttempts = sanitizeMaxAttempts(maxAttempts);
  let processingRecovered = false;

  const replayDeadLetter = async (
    rawId: string,
  ): Promise<"replayed" | "not_found" | "unsupported_legacy_item"> => {
    const id = normalizeMemoryExtractionIdentifier(rawId, "id");
    const found = await findDeadLetterByStoredId(client, deadLetterKey, id, now);
    if (found === undefined) {
      return id.startsWith("legacy:") ? "unsupported_legacy_item" : "not_found";
    }
    if (!("job" in found.deadLetter)) {
      return "unsupported_legacy_item";
    }

    const replayedAt = requireValidMemoryExtractionDate(now(), "now");
    const replayJob: MemoryExtractionJob = {
      ...found.deadLetter.job,
      notBefore: replayedAt,
      attempts: 0,
    };
    const result = await client.eval(REPLAY_DEAD_LETTER_SCRIPT, {
      keys: [seenKey, readyKey, delayedKey, processingKey, deadLetterKey],
      arguments: [
        replayJob.idempotencyKey,
        serializeMemoryExtractionJob(replayJob),
        found.payload,
      ],
    });
    return result === 1 ? "replayed" : "not_found";
  };

  const deleteDeadLetter = async (
    rawId: string,
  ): Promise<"deleted" | "not_found" | "unsupported_legacy_item"> => {
    const id = normalizeMemoryExtractionIdentifier(rawId, "id");
    const found = await findDeadLetterByStoredId(client, deadLetterKey, id, now);
    if (found === undefined) {
      return id.startsWith("legacy:") ? "unsupported_legacy_item" : "not_found";
    }
    const result = await client.eval(DELETE_DEAD_LETTER_SCRIPT, {
      keys: [deadLetterKey],
      arguments: [found.payload],
    });
    return result === 1 ? "deleted" : "not_found";
  };

  return {
    async enqueue(job) {
      const payload = serializeMemoryExtractionJob(job);
      const normalizedJob = parseMemoryExtractionJob(payload);
      await client.eval(ENQUEUE_SCRIPT, {
        keys: [seenKey, readyKey, delayedKey, processingKey],
        arguments: [normalizedJob.idempotencyKey, payload],
      });
    },

    async dequeueBatch(limit, dequeueAt = now()) {
      const safeLimit = sanitizeQueueLimit(limit);
      if (safeLimit === 0) {
        return [];
      }
      const safeDequeueAt = requireValidMemoryExtractionDate(dequeueAt, "now");

      if (!processingRecovered) {
        await client.eval(RECOVER_PROCESSING_SCRIPT, {
          keys: [processingKey, readyKey],
          arguments: [],
        });
        processingRecovered = true;
      }
      await client.eval(PROMOTE_DUE_SCRIPT, {
        keys: [delayedKey, readyKey],
        arguments: [String(safeDequeueAt.getTime()), String(safeLimit)],
      });

      const jobs: MemoryExtractionJob[] = [];
      for (let index = 0; index < safeLimit; index += 1) {
        const result = await client.eval(DEQUEUE_SCRIPT, {
          keys: [readyKey, processingKey],
          arguments: [],
        });
        if (typeof result !== "string") {
          break;
        }
        try {
          jobs.push(parseMemoryExtractionJob(result));
        } catch (error) {
          const failedAt = requireValidMemoryExtractionDate(now(), "now");
          const diagnosticPayload = serializeInvalidPayloadDeadLetter({
            id: normalizeMemoryExtractionIdentifier(idGenerator(), "id"),
            rawPayload: result,
            errorMessage: error instanceof Error ? error.message : String(error),
            failedAt,
          });
          await client.eval(ACK_DEAD_LETTER_SCRIPT, {
            keys: [deadLetterKey, processingKey, seenKey, readyKey, delayedKey],
            arguments: [diagnosticPayload, result, ""],
          });
        }
      }
      return jobs;
    },

    async handleProcessedJob(job) {
      const payload = serializeMemoryExtractionJob(job);
      const normalizedJob = parseMemoryExtractionJob(payload);
      await client.eval(ACK_PROCESSED_SCRIPT, {
        keys: [processingKey, seenKey],
        arguments: [payload, normalizedJob.idempotencyKey],
      });
    },

    async handleFailedJob(input) {
      const originalPayload = serializeMemoryExtractionJob(input.job);
      const originalJob = parseMemoryExtractionJob(originalPayload);
      const attempts = originalJob.attempts + 1;
      const retryAt =
        input.retryAt === undefined
          ? originalJob.notBefore
          : requireValidMemoryExtractionDate(input.retryAt, "retryAt");
      const failedJob: MemoryExtractionJob = {
        ...originalJob,
        notBefore: retryAt,
        attempts,
      };
      const failedPayload = serializeMemoryExtractionJob(failedJob);

      if (attempts >= safeMaxAttempts) {
        const failedAt = requireValidMemoryExtractionDate(now(), "now");
        await client.eval(ACK_DEAD_LETTER_SCRIPT, {
          keys: [deadLetterKey, processingKey, seenKey, readyKey, delayedKey],
          arguments: [
            serializeJobDeadLetter({
              id: normalizeMemoryExtractionIdentifier(idGenerator(), "id"),
              job: failedJob,
              errorMessage: input.errorMessage,
              failedAt,
            }),
            originalPayload,
            originalJob.idempotencyKey,
          ],
        });
        return { action: "dead_lettered", attempts };
      }

      await client.eval(ACK_RETRY_SCRIPT, {
        keys: [seenKey, readyKey, delayedKey, processingKey],
        arguments: [
          failedJob.idempotencyKey,
          failedPayload,
          originalPayload,
          String(failedJob.notBefore.getTime()),
          input.retryAt === undefined ? "ready" : "delayed",
        ],
      });
      return { action: "requeued", attempts };
    },

    getPendingCount() {
      return client.lLen(readyKey);
    },

    getProcessingCount() {
      return client.lLen(processingKey);
    },

    getDelayedCount() {
      return client.zCard(delayedKey);
    },

    getDeadLetterCount() {
      return client.lLen(deadLetterKey);
    },

    async getProviderCooldown() {
      const value = await client.get(cooldownKey);
      if (value === null) {
        return undefined;
      }
      const cooldown = new Date(Number(value));
      return Number.isNaN(cooldown.getTime()) ? undefined : cooldown;
    },

    async setProviderCooldown(until) {
      const safeUntil = requireValidMemoryExtractionDate(until, "until");
      await client.eval(SET_COOLDOWN_SCRIPT, {
        keys: [cooldownKey],
        arguments: [String(safeUntil.getTime())],
      });
    },

    async listDeadLetters(input) {
      const safeLimit = sanitizeQueueLimit(input.limit);
      if (safeLimit === 0) {
        return [];
      }
      const payloads = await client.lRange(deadLetterKey, 0, safeLimit - 1);
      return payloads.map((payload, index) => parseDeadLetterPayload(payload, index, now).deadLetter);
    },

    replayDeadLetter,
    deleteDeadLetter,

    async replayDeadLetters(input): Promise<ReplayMemoryExtractionDeadLettersResult> {
      if (input.ids.length > MAX_MEMORY_EXTRACTION_QUEUE_LIMIT) {
        throw new Error(
          `memory extraction dead-letter batch must contain at most ${MAX_MEMORY_EXTRACTION_QUEUE_LIMIT} ids`,
        );
      }
      const result: ReplayMemoryExtractionDeadLettersResult = {
        replayedCount: 0,
        notFoundIds: [],
        unsupportedLegacyIds: [],
      };
      const ids = input.ids.map((id) => normalizeMemoryExtractionIdentifier(id, "id"));
      for (const id of new Set(ids)) {
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

export function serializeMemoryExtractionJob(job: MemoryExtractionJob): string {
  const rawPayload = {
    ...job,
    enqueuedAt: requireValidMemoryExtractionDate(job.enqueuedAt, "enqueuedAt").toISOString(),
    notBefore: requireValidMemoryExtractionDate(job.notBefore, "notBefore").toISOString(),
  };
  const normalized = parseMemoryExtractionJob(JSON.stringify(rawPayload));
  return JSON.stringify(serializeMemoryExtractionJobPayload(normalized));
}

export function parseMemoryExtractionJob(payload: string): MemoryExtractionJob {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw new Error("Invalid memory extraction job JSON");
  }
  if (
    !isRecord(parsed) ||
    !hasExactKeys(parsed, [
      "schemaVersion",
      "idempotencyKey",
      "requestId",
      "groupId",
      "enqueuedAt",
      "notBefore",
      "attempts",
    ])
  ) {
    throw new Error("Invalid memory extraction job payload");
  }

  try {
    const requestId = normalizeMemoryExtractionIdentifier(readString(parsed.requestId), "requestId");
    const groupId = normalizeMemoryExtractionIdentifier(readString(parsed.groupId), "groupId");
    const idempotencyKey = readString(parsed.idempotencyKey).trim();
    const enqueuedAt = parseValidDate(parsed.enqueuedAt);
    const notBefore = parseValidDate(parsed.notBefore);
    const attempts = readNonNegativeSafeInteger(parsed.attempts);
    if (
      parsed.schemaVersion !== MEMORY_EXTRACTION_SCHEMA_VERSION ||
      idempotencyKey.length === 0 ||
      idempotencyKey.length > MAX_MEMORY_EXTRACTION_IDEMPOTENCY_KEY_CHARS ||
      idempotencyKey !== createMemoryExtractionIdempotencyKey(requestId)
    ) {
      throw new Error("invalid fields");
    }
    return {
      schemaVersion: MEMORY_EXTRACTION_SCHEMA_VERSION,
      idempotencyKey,
      requestId,
      groupId,
      enqueuedAt,
      notBefore,
      attempts,
    };
  } catch {
    throw new Error("Invalid memory extraction job payload");
  }
}

function serializeMemoryExtractionJobPayload(job: MemoryExtractionJob): Record<string, unknown> {
  return {
    schemaVersion: job.schemaVersion,
    idempotencyKey: job.idempotencyKey,
    requestId: job.requestId,
    groupId: job.groupId,
    enqueuedAt: job.enqueuedAt.toISOString(),
    notBefore: job.notBefore.toISOString(),
    attempts: job.attempts,
  };
}

function serializeJobDeadLetter(input: {
  id: string;
  job: MemoryExtractionJob;
  errorMessage: string;
  failedAt: Date;
}): string {
  return JSON.stringify({
    id: input.id,
    job: serializeMemoryExtractionJobPayload(
      parseMemoryExtractionJob(serializeMemoryExtractionJob(input.job)),
    ),
    errorMessage: normalizeDeadLetterErrorMessage(input.errorMessage),
    failedAt: input.failedAt.toISOString(),
  });
}

function serializeInvalidPayloadDeadLetter(input: {
  id: string;
  rawPayload: string;
  errorMessage: string;
  failedAt: Date;
}): string {
  return JSON.stringify({
    id: input.id,
    payloadDigest: digestPayload(input.rawPayload),
    payloadBytes: Buffer.byteLength(input.rawPayload, "utf8"),
    errorMessage: normalizeDeadLetterErrorMessage(input.errorMessage),
    failedAt: input.failedAt.toISOString(),
  });
}

type ParsedDeadLetterPayload = {
  payload: string;
  deadLetter: MemoryExtractionDeadLetter;
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
    return invalidDeadLetterDiagnostic(payload, index, "Invalid memory extraction dead letter JSON", now);
  }
  if (!isRecord(parsed)) {
    return invalidDeadLetterDiagnostic(
      payload,
      index,
      "Invalid memory extraction dead letter payload",
      now,
    );
  }
  const storedId = readBoundedStoredId(parsed.id);

  try {
    if (hasExactKeys(parsed, ["id", "job", "errorMessage", "failedAt"])) {
      const id = normalizeMemoryExtractionIdentifier(readString(parsed.id), "id");
      const job = parseMemoryExtractionJob(JSON.stringify(parsed.job));
      const errorMessage = readBoundedErrorMessage(parsed.errorMessage);
      const failedAt = parseValidDate(parsed.failedAt);
      return {
        payload,
        storedId: id,
        deadLetter: { id, job, errorMessage, failedAt, replayable: true },
      };
    }
    if (
      hasExactKeys(parsed, [
        "id",
        "payloadDigest",
        "payloadBytes",
        "errorMessage",
        "failedAt",
      ])
    ) {
      const id = normalizeMemoryExtractionIdentifier(readString(parsed.id), "id");
      const payloadDigest = readString(parsed.payloadDigest);
      const payloadBytes = readNonNegativeSafeInteger(parsed.payloadBytes);
      const errorMessage = readBoundedErrorMessage(parsed.errorMessage);
      const failedAt = parseValidDate(parsed.failedAt);
      if (!/^sha256:[a-f0-9]{64}$/.test(payloadDigest)) {
        throw new Error("invalid digest");
      }
      return {
        payload,
        storedId: id,
        deadLetter: {
          id,
          payloadDigest,
          payloadBytes,
          errorMessage,
          failedAt,
          replayable: false,
        },
      };
    }
  } catch {
    // Fall through to a content-free diagnostic for malformed legacy data.
  }
  return invalidDeadLetterDiagnostic(
    payload,
    index,
    "Invalid memory extraction dead letter payload",
    now,
    storedId,
  );
}

function invalidDeadLetterDiagnostic(
  payload: string,
  index: number,
  errorMessage: string,
  now: () => Date,
  storedId?: string,
): ParsedDeadLetterPayload {
  const payloadDigest = digestPayload(payload);
  return {
    payload,
    storedId,
    deadLetter: {
      id: storedId ?? `legacy:${index}:${payloadDigest.slice("sha256:".length, 23)}`,
      payloadDigest,
      payloadBytes: Buffer.byteLength(payload, "utf8"),
      errorMessage,
      failedAt: requireValidMemoryExtractionDate(now(), "now"),
      replayable: false,
    },
  };
}

async function findDeadLetterByStoredId(
  client: RedisMemoryExtractionQueueClient,
  deadLetterKey: string,
  id: string,
  now: () => Date,
): Promise<ParsedDeadLetterPayload | undefined> {
  const payloads = await client.lRange(deadLetterKey, 0, MAX_MEMORY_EXTRACTION_QUEUE_LIMIT - 1);
  for (const [index, payload] of payloads.entries()) {
    const parsed = parseDeadLetterPayload(payload, index, now);
    if (parsed.storedId === id) {
      return parsed;
    }
  }
  return undefined;
}

function digestPayload(payload: string): string {
  return `sha256:${createHash("sha256").update(payload, "utf8").digest("hex")}`;
}

function sanitizeQueueLimit(limit: number): number {
  if (!Number.isFinite(limit) || Math.abs(limit) > Number.MAX_SAFE_INTEGER) {
    throw new Error("memory extraction queue limit must be a finite safe-magnitude number");
  }
  return Math.min(MAX_MEMORY_EXTRACTION_QUEUE_LIMIT, Math.max(0, Math.floor(limit)));
}

function sanitizeMaxAttempts(maxAttempts: number): number {
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts <= 0) {
    throw new Error("maxAttempts must be a positive safe integer");
  }
  return maxAttempts;
}

function parseValidDate(value: unknown): Date {
  if (typeof value !== "string") {
    throw new Error("invalid date");
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error("invalid date");
  }
  return date;
}

function readString(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("invalid string");
  }
  return value;
}

function readNonNegativeSafeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error("invalid integer");
  }
  return value as number;
}

function readBoundedErrorMessage(value: unknown): string {
  const errorMessage = readString(value);
  if (errorMessage.length === 0 || errorMessage.length > 1000) {
    throw new Error("invalid error message");
  }
  return errorMessage;
}

function readBoundedStoredId(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const id = value.trim();
  if (id.length === 0 || id.length > MAX_MEMORY_EXTRACTION_IDENTIFIER_CHARS) {
    return undefined;
  }
  return id;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expectedKeys: string[]): boolean {
  const actualKeys = Object.keys(value).sort();
  const sortedExpectedKeys = [...expectedKeys].sort();
  return (
    actualKeys.length === sortedExpectedKeys.length &&
    actualKeys.every((key, index) => key === sortedExpectedKeys[index])
  );
}
