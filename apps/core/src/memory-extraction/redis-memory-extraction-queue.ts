import { createHash, randomUUID } from "node:crypto";

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
  type MemoryExtractionTerminalErrorCode,
  type RecoverMemoryExtractionProcessingResult,
  type ReplayMemoryExtractionDeadLettersResult,
} from "./memory-extraction-queue.js";

const DEFAULT_SEEN_KEY = "iris:memory:extraction:seen";
const DEFAULT_READY_KEY = "iris:memory:extraction:ready";
const DEFAULT_READY_SET_KEY = "iris:memory:extraction:ready:ids";
const DEFAULT_DELAYED_KEY = "iris:memory:extraction:delayed";
const DEFAULT_PROCESSING_KEY = "iris:memory:extraction:processing";
const DEFAULT_STATE_KEY = "iris:memory:extraction:state";
const DEFAULT_PAYLOAD_KEY = "iris:memory:extraction:payloads";
const DEFAULT_MEMBER_KEY = "iris:memory:extraction:members";
const DEFAULT_COOLDOWN_KEY = "iris:memory:extraction:cooldown";
const DEFAULT_DEAD_LETTER_KEY = "iris:memory:extraction:dlq";
const DEFAULT_DEAD_LETTER_INDEX_KEY = "iris:memory:extraction:dlq:index";
const DEFAULT_MAX_ATTEMPTS = 5;
const MAX_DEQUEUE_POPS = MAX_MEMORY_EXTRACTION_QUEUE_LIMIT * 2;
const DEAD_LETTER_STALE_REPAIR_LIMIT = MAX_MEMORY_EXTRACTION_QUEUE_LIMIT;
const CLAIMED_PAYLOAD = Symbol("memoryExtractionClaimedPayload");
const ALLOWED_FAILURE_CODES = new Set([
  "provider_timeout",
  "provider_rate_limited",
  "provider_unavailable",
  "provider_unauthorized",
  "invalid_model_response",
  "invalid_queue_payload",
  "corrupt_routing",
  "invalid_dead_letter_payload",
  "invalid_dead_letter_json",
  "internal_error",
]);
const TERMINAL_FAILURE_CODES = new Set<MemoryExtractionTerminalErrorCode>([
  "provider_unauthorized",
  "invalid_model_response",
  "corrupt_routing",
]);

const ENQUEUE_SCRIPT = `
-- memory-extraction:enqueue
local state = redis.call("HGET", KEYS[7], ARGV[1])
local indexed_payload = redis.call("HGET", KEYS[8], ARGV[1])
local physical = false
if state == "ready" and indexed_payload
  and redis.call("ZSCORE", KEYS[3], ARGV[1]) then
  physical = true
elseif state == "delayed" and indexed_payload
  and redis.call("ZSCORE", KEYS[4], ARGV[1]) then
  physical = true
elseif state == "processing" and indexed_payload
  and redis.call("ZSCORE", KEYS[5], ARGV[1]) then
  physical = true
elseif state == "recovery" and indexed_payload
  and redis.call("SISMEMBER", KEYS[6], ARGV[1]) == 1 then
  physical = true
end
if physical then
  redis.call("SADD", KEYS[1], ARGV[1])
  return 0
end

redis.call("ZREM", KEYS[3], ARGV[1])
redis.call("ZREM", KEYS[4], ARGV[1])
redis.call("ZREM", KEYS[5], ARGV[1])
redis.call("SREM", KEYS[6], ARGV[1])
redis.call("SREM", KEYS[11], ARGV[1])
if indexed_payload then
  redis.call("HDEL", KEYS[9], indexed_payload)
  redis.call("HDEL", KEYS[10], indexed_payload)
end
redis.call("HSET", KEYS[8], ARGV[1], ARGV[2])
if ARGV[3] == "delayed" then
  redis.call("ZADD", KEYS[4], ARGV[4], ARGV[1])
  redis.call("HSET", KEYS[7], ARGV[1], "delayed")
else
  local sequence = redis.call("INCR", KEYS[12])
  redis.call("RPUSH", KEYS[2], ARGV[1])
  redis.call("ZADD", KEYS[3], sequence, ARGV[1])
  redis.call("SADD", KEYS[11], ARGV[1])
  redis.call("HSET", KEYS[7], ARGV[1], "ready")
end
redis.call("SADD", KEYS[1], ARGV[1])
return 1
`;

const RECOVER_PROCESSING_SCRIPT = `
-- memory-extraction:recover-processing
local processing = redis.call(
  "ZRANGEBYSCORE", KEYS[1], "-inf", "+inf", "WITHSCORES", "LIMIT", 0, ARGV[1]
)
local recovered = 0
for index = 1, #processing, 2 do
  local idempotency_key = processing[index]
  local sequence = processing[index + 1]
  if redis.call("ZREM", KEYS[1], idempotency_key) == 1 then
    if redis.call("HGET", KEYS[6], idempotency_key) == "processing"
      and redis.call("HGET", KEYS[7], idempotency_key) then
      redis.call("RPUSH", KEYS[2], idempotency_key)
      redis.call("SADD", KEYS[3], idempotency_key)
      redis.call("ZADD", KEYS[4], sequence, idempotency_key)
      redis.call("SADD", KEYS[5], idempotency_key)
      redis.call("HSET", KEYS[6], idempotency_key, "recovery")
      recovered = recovered + 1
    else
      redis.call("ZREM", KEYS[4], idempotency_key)
      redis.call("SREM", KEYS[5], idempotency_key)
    end
  end
end
return { recovered, redis.call("ZCARD", KEYS[1]) }
`;

const PROMOTE_DUE_SCRIPT = `
-- memory-extraction:promote-due
local due = redis.call(
  "ZRANGEBYSCORE", KEYS[1], "-inf", ARGV[1], "LIMIT", 0, ARGV[2]
)
for _, payload in ipairs(due) do
  local idempotency_key = payload
  if redis.call("ZREM", KEYS[1], idempotency_key) == 1 then
    if redis.call("HGET", KEYS[4], idempotency_key) == "delayed"
      and redis.call("HGET", KEYS[5], idempotency_key) then
      local sequence = redis.call("INCR", KEYS[7])
      redis.call("RPUSH", KEYS[2], idempotency_key)
      redis.call("ZADD", KEYS[3], sequence, idempotency_key)
      redis.call("SADD", KEYS[6], idempotency_key)
      redis.call("HSET", KEYS[4], idempotency_key, "ready")
    end
  end
end
return #due
`;

const DEQUEUE_SCRIPT = `
-- memory-extraction:dequeue
local claimed = {}
local popped = 0
while #claimed / 2 < tonumber(ARGV[1]) and popped < tonumber(ARGV[2]) do
  local idempotency_key = redis.call("LPOP", KEYS[1])
  local expected_state = "recovery"
  if idempotency_key then
    redis.call("SREM", KEYS[2], idempotency_key)
  else
    idempotency_key = redis.call("LPOP", KEYS[3])
    expected_state = "ready"
  end
  if not idempotency_key then break end
  popped = popped + 1
  local payload = redis.call("HGET", KEYS[8], idempotency_key)
  local indexed = redis.call("ZSCORE", KEYS[4], idempotency_key)
  if payload and indexed
    and redis.call("HGET", KEYS[7], idempotency_key) == expected_state then
    redis.call("ZREM", KEYS[4], idempotency_key)
    redis.call("SREM", KEYS[5], idempotency_key)
    local sequence = redis.call("INCR", KEYS[9])
    redis.call("ZADD", KEYS[6], sequence, idempotency_key)
    redis.call("HSET", KEYS[7], idempotency_key, "processing")
    table.insert(claimed, idempotency_key)
    table.insert(claimed, payload)
  elseif string.sub(idempotency_key, 1, 18) == "memory-extraction:" then
    if indexed and redis.call("HGET", KEYS[7], idempotency_key) == expected_state then
      redis.call("ZREM", KEYS[4], idempotency_key)
      redis.call("SREM", KEYS[5], idempotency_key)
    end
  else
    local payload = idempotency_key
    local invalid_key = "invalid:" .. redis.sha1hex(payload)
    if redis.call("HGET", KEYS[7], invalid_key) ~= "processing"
      or redis.call("HGET", KEYS[8], invalid_key) ~= invalid_key then
      redis.call("HSET", KEYS[7], invalid_key, "processing")
      redis.call("HSET", KEYS[8], invalid_key, invalid_key)
      local sequence = redis.call("INCR", KEYS[9])
      redis.call("ZADD", KEYS[6], sequence, invalid_key)
      table.insert(claimed, invalid_key)
      table.insert(claimed, payload)
    end
  end
end
return claimed
`;

const ACK_PROCESSED_SCRIPT = `
-- memory-extraction:ack-processed
if redis.call("HGET", KEYS[7], ARGV[1]) ~= "processing"
  or redis.call("HGET", KEYS[8], ARGV[1]) ~= ARGV[2]
  or not redis.call("ZSCORE", KEYS[1], ARGV[1]) then return 0 end
redis.call("ZREM", KEYS[1], ARGV[1])
redis.call("HDEL", KEYS[7], ARGV[1])
redis.call("HDEL", KEYS[8], ARGV[1])
redis.call("SREM", KEYS[2], ARGV[1])
redis.call("ZREM", KEYS[3], ARGV[1])
redis.call("SREM", KEYS[4], ARGV[1])
redis.call("ZREM", KEYS[5], ARGV[1])
redis.call("SREM", KEYS[6], ARGV[1])
redis.call("HDEL", KEYS[9], ARGV[2])
redis.call("HDEL", KEYS[10], ARGV[2])
return 1
`;

const ACK_RETRY_SCRIPT = `
-- memory-extraction:ack-retry
if redis.call("HGET", KEYS[8], ARGV[1]) ~= "processing"
  or redis.call("HGET", KEYS[9], ARGV[1]) ~= ARGV[3]
  or not redis.call("ZSCORE", KEYS[6], ARGV[1]) then return 0 end
redis.call("ZREM", KEYS[6], ARGV[1])
redis.call("ZREM", KEYS[3], ARGV[1])
redis.call("ZREM", KEYS[5], ARGV[1])
redis.call("SREM", KEYS[4], ARGV[1])
redis.call("SREM", KEYS[7], ARGV[1])
redis.call("HDEL", KEYS[10], ARGV[3])
redis.call("HDEL", KEYS[11], ARGV[3])
redis.call("HSET", KEYS[9], ARGV[1], ARGV[2])
if ARGV[5] == "delayed" then
  redis.call("ZADD", KEYS[5], ARGV[4], ARGV[1])
  redis.call("HSET", KEYS[8], ARGV[1], "delayed")
else
  local sequence = redis.call("INCR", KEYS[12])
  redis.call("RPUSH", KEYS[2], ARGV[1])
  redis.call("ZADD", KEYS[3], sequence, ARGV[1])
  redis.call("SADD", KEYS[4], ARGV[1])
  redis.call("HSET", KEYS[8], ARGV[1], "ready")
end
redis.call("SADD", KEYS[1], ARGV[1])
return 1
`;

const ACK_DEAD_LETTER_SCRIPT = `
-- memory-extraction:ack-dead-letter
if redis.call("HGET", KEYS[9], ARGV[3]) ~= "processing"
  or redis.call("HGET", KEYS[10], ARGV[3]) ~= ARGV[4]
  or not redis.call("ZSCORE", KEYS[6], ARGV[3]) then return 0 end
local sequence = redis.call("INCR", KEYS[12])
redis.call("ZADD", KEYS[1], sequence, ARGV[1])
redis.call("HSET", KEYS[2], ARGV[1], ARGV[2])
redis.call("SADD", KEYS[14], ARGV[1])
redis.call("ZREM", KEYS[6], ARGV[3])
redis.call("HDEL", KEYS[9], ARGV[3])
redis.call("HDEL", KEYS[10], ARGV[3])
redis.call("SREM", KEYS[4], ARGV[3])
redis.call("ZREM", KEYS[3], ARGV[3])
redis.call("ZREM", KEYS[7], ARGV[3])
redis.call("SREM", KEYS[8], ARGV[3])
redis.call("HDEL", KEYS[11], ARGV[4])
redis.call("HDEL", KEYS[13], ARGV[4])
return 1
`;

const ACK_TERMINAL_SCRIPT = `
-- memory-extraction:ack-terminal
local exact_processing = redis.call("HGET", KEYS[9], ARGV[3]) == "processing"
  and redis.call("HGET", KEYS[10], ARGV[3]) == ARGV[4]
  and redis.call("ZSCORE", KEYS[6], ARGV[3])
if exact_processing then
  if redis.call("SISMEMBER", KEYS[14], ARGV[1]) ~= 1
    or not redis.call("HGET", KEYS[2], ARGV[1])
    or not redis.call("ZSCORE", KEYS[1], ARGV[1]) then
    local sequence = redis.call("INCR", KEYS[12])
    redis.call("ZADD", KEYS[1], sequence, ARGV[1])
    redis.call("HSET", KEYS[2], ARGV[1], ARGV[2])
    redis.call("SADD", KEYS[14], ARGV[1])
  end
  redis.call("ZREM", KEYS[6], ARGV[3])
  redis.call("HDEL", KEYS[9], ARGV[3])
  redis.call("HDEL", KEYS[10], ARGV[3])
  redis.call("SREM", KEYS[4], ARGV[3])
  redis.call("ZREM", KEYS[3], ARGV[3])
  redis.call("ZREM", KEYS[7], ARGV[3])
  redis.call("SREM", KEYS[8], ARGV[3])
  redis.call("HDEL", KEYS[11], ARGV[4])
  redis.call("HDEL", KEYS[13], ARGV[4])
  return 1
end
if redis.call("SISMEMBER", KEYS[14], ARGV[1]) == 1
  and redis.call("HGET", KEYS[2], ARGV[1])
  and redis.call("ZSCORE", KEYS[1], ARGV[1]) then return 2 end
return 0
`;

const REPLAY_DEAD_LETTER_SCRIPT = `
-- memory-extraction:replay-dead-letter
local function is_canonical_dlq_id(value)
  return string.len(value) == 68
    and string.match(value, "^dlq:[0-9a-f]+$") ~= nil
end
if not is_canonical_dlq_id(ARGV[3])
  or redis.call("SISMEMBER", KEYS[15], ARGV[3]) ~= 1
  or not redis.call("ZSCORE", KEYS[12], ARGV[3])
  or redis.call("HGET", KEYS[11], ARGV[3]) ~= ARGV[4] then return 0 end
local state = redis.call("HGET", KEYS[8], ARGV[1])
local existing_payload = redis.call("HGET", KEYS[9], ARGV[1])
if state == "processing" and existing_payload
  and redis.call("ZSCORE", KEYS[6], ARGV[1]) then
  redis.call("HDEL", KEYS[11], ARGV[3])
  redis.call("ZREM", KEYS[12], ARGV[3])
  redis.call("SREM", KEYS[15], ARGV[3])
  return 1
end
if existing_payload then
  redis.call("HDEL", KEYS[10], existing_payload)
  redis.call("HDEL", KEYS[13], existing_payload)
end
redis.call("ZREM", KEYS[3], ARGV[1])
redis.call("ZREM", KEYS[5], ARGV[1])
redis.call("ZREM", KEYS[6], ARGV[1])
redis.call("SREM", KEYS[4], ARGV[1])
redis.call("SREM", KEYS[7], ARGV[1])
redis.call("HSET", KEYS[9], ARGV[1], ARGV[2])
local sequence = redis.call("INCR", KEYS[14])
redis.call("RPUSH", KEYS[2], ARGV[1])
redis.call("ZADD", KEYS[3], sequence, ARGV[1])
redis.call("SADD", KEYS[4], ARGV[1])
redis.call("HSET", KEYS[8], ARGV[1], "ready")
redis.call("SADD", KEYS[1], ARGV[1])
redis.call("HDEL", KEYS[11], ARGV[3])
redis.call("ZREM", KEYS[12], ARGV[3])
redis.call("SREM", KEYS[15], ARGV[3])
return 1
`;

const LIST_DEAD_LETTERS_SCRIPT = `
-- memory-extraction:list-dead-letters
local function is_canonical_dlq_id(value)
  return string.len(value) == 68
    and string.match(value, "^dlq:[0-9a-f]+$") ~= nil
end
local limit = tonumber(ARGV[1])
local stale_limit = tonumber(ARGV[2])
local ids = redis.call("ZRANGE", KEYS[2], 0, limit + stale_limit - 1)
local listed = {}
local stale_removed = 0
for _, id in ipairs(ids) do
  if not is_canonical_dlq_id(id) and stale_removed < stale_limit then
    redis.call("ZREM", KEYS[2], id)
    redis.call("HDEL", KEYS[1], id)
    redis.call("SREM", KEYS[3], id)
    stale_removed = stale_removed + 1
  elseif not is_canonical_dlq_id(id) then
    break
  else
    local payload = redis.call("HGET", KEYS[1], id)
    local authoritative = redis.call("SISMEMBER", KEYS[3], id) == 1
    if payload and authoritative then
      table.insert(listed, id)
      table.insert(listed, payload)
      if #listed / 2 >= limit then break end
    elseif stale_removed < stale_limit then
      redis.call("ZREM", KEYS[2], id)
      redis.call("HDEL", KEYS[1], id)
      redis.call("SREM", KEYS[3], id)
      stale_removed = stale_removed + 1
    else
      break
    end
  end
end
return listed
`;

const FIND_DEAD_LETTER_SCRIPT = `
-- memory-extraction:find-dead-letter
local function is_canonical_dlq_id(value)
  return string.len(value) == 68
    and string.match(value, "^dlq:[0-9a-f]+$") ~= nil
end
if not is_canonical_dlq_id(ARGV[1])
  or redis.call("SISMEMBER", KEYS[3], ARGV[1]) ~= 1
  or not redis.call("ZSCORE", KEYS[2], ARGV[1]) then return nil end
return redis.call("HGET", KEYS[1], ARGV[1])
`;

const DELETE_DEAD_LETTER_SCRIPT = `
-- memory-extraction:delete-dead-letter
local function is_canonical_dlq_id(value)
  return string.len(value) == 68
    and string.match(value, "^dlq:[0-9a-f]+$") ~= nil
end
if not is_canonical_dlq_id(ARGV[1])
  or redis.call("SISMEMBER", KEYS[3], ARGV[1]) ~= 1
  or not redis.call("ZSCORE", KEYS[2], ARGV[1])
  or redis.call("HGET", KEYS[1], ARGV[1]) ~= ARGV[2] then return 0 end
redis.call("HDEL", KEYS[1], ARGV[1])
redis.call("ZREM", KEYS[2], ARGV[1])
redis.call("SREM", KEYS[3], ARGV[1])
return 1
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
  ): Promise<number | string | Array<number | string> | null>;
  sCard(key: string): Promise<number>;
  zCard(key: string): Promise<number>;
  get(key: string): Promise<string | null>;
};

export type RedisMemoryExtractionQueueOptions = {
  client: RedisMemoryExtractionQueueClient;
  seenKey?: string;
  readyKey?: string;
  readySetKey?: string;
  delayedKey?: string;
  processingKey?: string;
  stateKey?: string;
  payloadKey?: string;
  memberKey?: string;
  cooldownKey?: string;
  deadLetterKey?: string;
  deadLetterIndexKey?: string;
  maxAttempts?: number;
  now?: () => Date;
  idGenerator?: () => string;
};

export function createRedisMemoryExtractionQueue({
  client,
  seenKey = DEFAULT_SEEN_KEY,
  readyKey = DEFAULT_READY_KEY,
  readySetKey = DEFAULT_READY_SET_KEY,
  delayedKey = DEFAULT_DELAYED_KEY,
  processingKey = DEFAULT_PROCESSING_KEY,
  stateKey = DEFAULT_STATE_KEY,
  payloadKey = DEFAULT_PAYLOAD_KEY,
  memberKey = DEFAULT_MEMBER_KEY,
  cooldownKey = DEFAULT_COOLDOWN_KEY,
  deadLetterKey = DEFAULT_DEAD_LETTER_KEY,
  deadLetterIndexKey = DEFAULT_DEAD_LETTER_INDEX_KEY,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  now = () => new Date(),
  idGenerator = randomUUID,
}: RedisMemoryExtractionQueueOptions): MemoryExtractionQueue {
  const safeMaxAttempts = sanitizeMaxAttempts(maxAttempts);
  const readyCountKey = `${readyKey}:counts`;
  const readyIndexKey = `${readyKey}:index`;
  const readySequenceKey = `${readyKey}:sequence`;
  const processingSequenceKey = `${processingKey}:sequence`;
  const recoveryKey = `${processingKey}:recovery`;
  const recoverySetKey = `${processingKey}:recovery:ids`;
  const deadLetterOrderKey = `${deadLetterKey}:order`;
  const deadLetterAuthorityKey = `${deadLetterKey}:ids`;
  const deadLetterSequenceKey = `${deadLetterKey}:sequence`;
  let processingRecovered = false;

  const recoverProcessing = async (
    rawLimit: number,
  ): Promise<RecoverMemoryExtractionProcessingResult> => {
    const safeLimit = sanitizeQueueLimit(rawLimit);
    if (safeLimit === 0) {
      return { recoveredCount: 0, remainingCount: 0 };
    }
    const result = await client.eval(RECOVER_PROCESSING_SCRIPT, {
      keys: [
        processingKey,
        recoveryKey,
        recoverySetKey,
        readyIndexKey,
        readySetKey,
        stateKey,
        payloadKey,
      ],
      arguments: [String(safeLimit)],
    });
    if (!Array.isArray(result) || result.length !== 2) {
      throw new Error("Invalid memory extraction processing recovery result");
    }
    const recoveredCount = readRecoveryCount(result[0]);
    const remainingCount = readRecoveryCount(result[1]);
    processingRecovered = remainingCount === 0;
    return { recoveredCount, remainingCount };
  };

  const replayDeadLetter = async (
    rawId: string,
  ): Promise<"replayed" | "not_found" | "unsupported_legacy_item"> => {
    const id = normalizeMemoryExtractionIdentifier(rawId, "id");
    const found = await findDeadLetterByStoredId(
      client,
      deadLetterIndexKey,
      deadLetterOrderKey,
      deadLetterAuthorityKey,
      id,
      now,
    );
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
      keys: [
        seenKey,
        readyKey,
        readyIndexKey,
        readySetKey,
        delayedKey,
        processingKey,
        recoverySetKey,
        stateKey,
        payloadKey,
        memberKey,
        deadLetterIndexKey,
        deadLetterOrderKey,
        readyCountKey,
        readySequenceKey,
        deadLetterAuthorityKey,
      ],
      arguments: [
        replayJob.idempotencyKey,
        serializeMemoryExtractionJob(replayJob),
        id,
        found.payload,
      ],
    });
    return result === 1 ? "replayed" : "not_found";
  };

  const deleteDeadLetter = async (
    rawId: string,
  ): Promise<"deleted" | "not_found" | "unsupported_legacy_item"> => {
    const id = normalizeMemoryExtractionIdentifier(rawId, "id");
    const found = await findDeadLetterByStoredId(
      client,
      deadLetterIndexKey,
      deadLetterOrderKey,
      deadLetterAuthorityKey,
      id,
      now,
    );
    if (found === undefined) {
      return id.startsWith("legacy:") ? "unsupported_legacy_item" : "not_found";
    }
    const result = await client.eval(DELETE_DEAD_LETTER_SCRIPT, {
      keys: [deadLetterIndexKey, deadLetterOrderKey, deadLetterAuthorityKey],
      arguments: [id, found.payload],
    });
    return result === 1 ? "deleted" : "not_found";
  };

  return {
    async enqueue(job) {
      const payload = serializeMemoryExtractionJob(job);
      const normalizedJob = parseMemoryExtractionJob(payload);
      const enqueueAt = requireValidMemoryExtractionDate(now(), "now");
      const destination = normalizedJob.notBefore > enqueueAt ? "delayed" : "ready";
      await client.eval(ENQUEUE_SCRIPT, {
        keys: [
          seenKey,
          readyKey,
          readyIndexKey,
          delayedKey,
          processingKey,
          recoverySetKey,
          stateKey,
          payloadKey,
          memberKey,
          readyCountKey,
          readySetKey,
          readySequenceKey,
        ],
        arguments: [
          normalizedJob.idempotencyKey,
          payload,
          destination,
          String(normalizedJob.notBefore.getTime()),
        ],
      });
    },

    async recoverProcessing(input) {
      return recoverProcessing(input.limit);
    },

    async dequeueBatch(limit, dequeueAt = now()) {
      const safeLimit = sanitizeQueueLimit(limit);
      if (safeLimit === 0) {
        return [];
      }
      const safeDequeueAt = requireValidMemoryExtractionDate(dequeueAt, "now");

      if (!processingRecovered) {
        const recovery = await recoverProcessing(MAX_MEMORY_EXTRACTION_QUEUE_LIMIT);
        if (recovery.remainingCount > 0) {
          return [];
        }
      }
      await client.eval(PROMOTE_DUE_SCRIPT, {
        keys: [
          delayedKey,
          readyKey,
          readyIndexKey,
          stateKey,
          payloadKey,
          readySetKey,
          readySequenceKey,
        ],
        arguments: [String(safeDequeueAt.getTime()), String(safeLimit)],
      });

      const jobs: MemoryExtractionJob[] = [];
      const result = await client.eval(DEQUEUE_SCRIPT, {
        keys: [
          recoveryKey,
          recoverySetKey,
          readyKey,
          readyIndexKey,
          readySetKey,
          processingKey,
          stateKey,
          payloadKey,
          processingSequenceKey,
          memberKey,
          readyCountKey,
        ],
        arguments: [
          String(safeLimit),
          String(MAX_DEQUEUE_POPS),
        ],
      });
      if (!Array.isArray(result)) {
        return jobs;
      }
      for (let index = 0; index + 1 < result.length; index += 2) {
        const claimId = result[index];
        const claimedPayload = result[index + 1];
        if (typeof claimId !== "string" || typeof claimedPayload !== "string") {
          continue;
        }
        try {
          const job = parseMemoryExtractionJob(claimedPayload);
          if (job.idempotencyKey !== claimId) {
            throw new Error("Invalid memory extraction job payload");
          }
          if (job.attempts >= safeMaxAttempts) {
            throw new Error("Memory extraction job attempts are exhausted");
          }
          Object.defineProperty(job, CLAIMED_PAYLOAD, {
            value: { idempotencyKey: claimId, payload: claimedPayload },
          });
          jobs.push(job);
        } catch {
          const failedAt = requireValidMemoryExtractionDate(now(), "now");
          const deadLetterId = createGeneratedDeadLetterId(idGenerator());
          const diagnosticPayload = serializeInvalidPayloadDeadLetter({
            id: deadLetterId,
            rawPayload: claimedPayload,
            failedAt,
          });
          await client.eval(ACK_DEAD_LETTER_SCRIPT, {
            keys: [
              deadLetterOrderKey,
              deadLetterIndexKey,
              readyIndexKey,
              seenKey,
              readySetKey,
              processingKey,
              delayedKey,
              recoverySetKey,
              stateKey,
              payloadKey,
              memberKey,
              deadLetterSequenceKey,
              readyCountKey,
              deadLetterAuthorityKey,
            ],
            arguments: [
              deadLetterId,
              diagnosticPayload,
              claimId,
              claimId.startsWith("invalid:") ? claimId : claimedPayload,
            ],
          });
        }
      }
      return jobs;
    },

    async handleProcessedJob(job) {
      const claimed = readClaimedPayload(job);
      const payload = claimed?.payload ?? serializeMemoryExtractionJob(job);
      const idempotencyKey = claimed?.idempotencyKey ?? parseMemoryExtractionJob(payload).idempotencyKey;
      await client.eval(ACK_PROCESSED_SCRIPT, {
        keys: [
          processingKey,
          seenKey,
          readyIndexKey,
          readySetKey,
          delayedKey,
          recoverySetKey,
          stateKey,
          payloadKey,
          memberKey,
          readyCountKey,
        ],
        arguments: [idempotencyKey, payload],
      });
    },

    async handleTerminalJob(input) {
      if (!TERMINAL_FAILURE_CODES.has(input.errorCode)) {
        throw new Error("memory extraction terminal error code is invalid");
      }
      const claimed = readClaimedPayload(input.job);
      const originalPayload = claimed?.payload ?? serializeMemoryExtractionJob(input.job);
      const originalJob = parseMemoryExtractionJob(originalPayload);
      const claimId = claimed?.idempotencyKey ?? originalJob.idempotencyKey;
      const attempts = originalJob.attempts + 1;
      const failedJob: MemoryExtractionJob = { ...originalJob, attempts };
      const failedAt = requireValidMemoryExtractionDate(now(), "now");
      const deadLetterId = createTerminalDeadLetterId({
        claimId,
        originalPayload,
        errorCode: input.errorCode,
      });
      const result = await client.eval(ACK_TERMINAL_SCRIPT, {
        keys: [
          deadLetterOrderKey,
          deadLetterIndexKey,
          readyIndexKey,
          seenKey,
          readySetKey,
          processingKey,
          delayedKey,
          recoverySetKey,
          stateKey,
          payloadKey,
          memberKey,
          deadLetterSequenceKey,
          readyCountKey,
          deadLetterAuthorityKey,
        ],
        arguments: [
          deadLetterId,
          serializeJobDeadLetter({
            id: deadLetterId,
            job: failedJob,
            errorMessage: input.errorCode,
            failedAt,
          }),
          claimId,
          originalPayload,
        ],
      });
      if (result !== 1 && result !== 2) {
        throw new Error("memory extraction terminal transition did not match processing job");
      }
      return { action: "dead_lettered" as const, attempts };
    },

    async handleFailedJob(input) {
      const claimed = readClaimedPayload(input.job);
      const originalPayload = claimed?.payload ?? serializeMemoryExtractionJob(input.job);
      const originalJob = parseMemoryExtractionJob(originalPayload);
      const claimId = claimed?.idempotencyKey ?? originalJob.idempotencyKey;
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
        const deadLetterId = createGeneratedDeadLetterId(idGenerator());
        await client.eval(ACK_DEAD_LETTER_SCRIPT, {
          keys: [
            deadLetterOrderKey,
            deadLetterIndexKey,
            readyIndexKey,
            seenKey,
            readySetKey,
            processingKey,
            delayedKey,
            recoverySetKey,
            stateKey,
            payloadKey,
            memberKey,
            deadLetterSequenceKey,
            readyCountKey,
            deadLetterAuthorityKey,
          ],
          arguments: [
            deadLetterId,
            serializeJobDeadLetter({
              id: deadLetterId,
              job: failedJob,
              errorMessage: input.errorMessage,
              failedAt,
            }),
            claimId,
            originalPayload,
          ],
        });
        return { action: "dead_lettered", attempts };
      }

      await client.eval(ACK_RETRY_SCRIPT, {
        keys: [
          seenKey,
          readyKey,
          readyIndexKey,
          readySetKey,
          delayedKey,
          processingKey,
          recoverySetKey,
          stateKey,
          payloadKey,
          memberKey,
          readyCountKey,
          readySequenceKey,
        ],
        arguments: [
          claimId,
          failedPayload,
          originalPayload,
          String(failedJob.notBefore.getTime()),
          input.retryAt === undefined ? "ready" : "delayed",
        ],
      });
      return { action: "requeued", attempts };
    },

    getPendingCount() {
      return client.zCard(readyIndexKey);
    },

    getProcessingCount() {
      return client.zCard(processingKey);
    },

    getDelayedCount() {
      return client.zCard(delayedKey);
    },

    getDeadLetterCount() {
      return client.sCard(deadLetterAuthorityKey);
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
      const listed = await client.eval(LIST_DEAD_LETTERS_SCRIPT, {
        keys: [deadLetterIndexKey, deadLetterOrderKey, deadLetterAuthorityKey],
        arguments: [String(safeLimit), String(DEAD_LETTER_STALE_REPAIR_LIMIT)],
      });
      if (!Array.isArray(listed)) {
        return [];
      }
      const deadLetters: MemoryExtractionDeadLetter[] = [];
      for (let index = 0; index + 1 < listed.length; index += 2) {
        const id = listed[index];
        const payload = listed[index + 1];
        if (
          typeof id !== "string" ||
          typeof payload !== "string" ||
          !isSafeDeadLetterIndexId(id)
        ) {
          continue;
        }
        const parsed = parseDeadLetterPayload(payload, index / 2, now);
        deadLetters.push(
          parsed.storedId === id
            ? parsed.deadLetter
            : invalidDeadLetterDiagnostic(
                payload,
                index / 2,
                "invalid_dead_letter_payload",
                now,
                id,
              ).deadLetter,
        );
      }
      return deadLetters;
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

function readClaimedPayload(job: MemoryExtractionJob):
  | { idempotencyKey: string; payload: string }
  | undefined {
  return (
    job as MemoryExtractionJob & {
      [CLAIMED_PAYLOAD]?: { idempotencyKey: string; payload: string };
    }
  )[CLAIMED_PAYLOAD];
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
      attempts >= Number.MAX_SAFE_INTEGER ||
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
    errorMessage: normalizeMemoryExtractionFailureCode(input.errorMessage),
    failedAt: input.failedAt.toISOString(),
  });
}

function normalizeMemoryExtractionFailureCode(errorMessage: string): string {
  return ALLOWED_FAILURE_CODES.has(errorMessage) ? errorMessage : "internal_error";
}

function serializeInvalidPayloadDeadLetter(input: {
  id: string;
  rawPayload: string;
  failedAt: Date;
}): string {
  return JSON.stringify({
    id: input.id,
    payloadDigest: digestPayload(input.rawPayload),
    payloadBytes: Buffer.byteLength(input.rawPayload, "utf8"),
    errorMessage: "invalid_queue_payload",
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
    return invalidDeadLetterDiagnostic(payload, index, "invalid_dead_letter_json", now);
  }
  if (!isRecord(parsed)) {
    return invalidDeadLetterDiagnostic(
      payload,
      index,
      "invalid_dead_letter_payload",
      now,
    );
  }
  const storedId = readBoundedStoredId(parsed.id);

  try {
    if (hasExactKeys(parsed, ["id", "job", "errorMessage", "failedAt"])) {
      const id = normalizeMemoryExtractionIdentifier(readString(parsed.id), "id");
      const job = parseMemoryExtractionJob(JSON.stringify(parsed.job));
      const errorMessage = readMemoryExtractionFailureCode(parsed.errorMessage);
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
      const errorMessage = readMemoryExtractionFailureCode(parsed.errorMessage);
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
    "invalid_dead_letter_payload",
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
  deadLetterIndexKey: string,
  deadLetterOrderKey: string,
  deadLetterAuthorityKey: string,
  id: string,
  now: () => Date,
): Promise<ParsedDeadLetterPayload | undefined> {
  const payload = await client.eval(FIND_DEAD_LETTER_SCRIPT, {
    keys: [deadLetterIndexKey, deadLetterOrderKey, deadLetterAuthorityKey],
    arguments: [id],
  });
  if (typeof payload !== "string") {
    return undefined;
  }
  const parsed = parseDeadLetterPayload(payload, 0, now);
  if (parsed.storedId !== id) {
    return invalidDeadLetterDiagnostic(
      payload,
      0,
      "invalid_dead_letter_payload",
      now,
      id,
    );
  }
  return parsed;
}

function digestPayload(payload: string): string {
  return `sha256:${createHash("sha256").update(payload, "utf8").digest("hex")}`;
}

function createGeneratedDeadLetterId(rawId: string): string {
  return `dlq:${createHash("sha256").update(rawId, "utf8").digest("hex")}`;
}

function createTerminalDeadLetterId(input: {
  claimId: string;
  originalPayload: string;
  errorCode: MemoryExtractionTerminalErrorCode;
}): string {
  return createGeneratedDeadLetterId(
    JSON.stringify([input.claimId, digestPayload(input.originalPayload), input.errorCode]),
  );
}

function readRecoveryCount(value: unknown): number {
  const count = typeof value === "string" ? Number(value) : value;
  if (!Number.isSafeInteger(count) || (count as number) < 0) {
    throw new Error("Invalid memory extraction processing recovery result");
  }
  return count as number;
}

function sanitizeQueueLimit(limit: number): number {
  if (!Number.isFinite(limit) || Math.abs(limit) > Number.MAX_SAFE_INTEGER) {
    throw new Error("memory extraction queue limit must be a finite safe-magnitude number");
  }
  if (!Number.isSafeInteger(limit)) {
    throw new Error("memory extraction queue limit must be a safe integer");
  }
  return Math.min(MAX_MEMORY_EXTRACTION_QUEUE_LIMIT, Math.max(0, limit));
}

function sanitizeMaxAttempts(maxAttempts: number): number {
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts <= 0) {
    throw new Error("maxAttempts must be a positive safe integer");
  }
  if (maxAttempts >= Number.MAX_SAFE_INTEGER) {
    throw new Error("maxAttempts must be less than Number.MAX_SAFE_INTEGER");
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

function readMemoryExtractionFailureCode(value: unknown): string {
  const errorMessage = readString(value);
  if (!ALLOWED_FAILURE_CODES.has(errorMessage)) {
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

function isSafeDeadLetterIndexId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9:._-]{0,511}$/.test(value);
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
