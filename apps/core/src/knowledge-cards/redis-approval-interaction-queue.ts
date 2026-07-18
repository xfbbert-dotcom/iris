import { createHash, randomUUID } from "node:crypto";

import {
  APPROVAL_INTERACTION_FAILURE_CODES,
  type ApprovalInteractionDeadLetter,
  type ApprovalInteractionFailureCode,
  type ApprovalInteractionInvalidPayloadDeadLetter,
  type ApprovalInteractionJobDeadLetter,
  type ApprovalInteractionQueue,
} from "./approval-interaction-queue.js";
import {
  normalizeApprovalInteractionJob,
  type ApprovalInteractionJob,
} from "./knowledge-card.js";

const DEFAULT_PREFIX = "iris:approval:interactions";
const DEFAULT_MAX_ATTEMPTS = 5;
const MAX_QUEUE_LIMIT = 100;
const MAX_IDENTIFIER_CHARS = 512;
const RETRY_DELAYS_MS = [1_000, 5_000, 30_000, 120_000] as const;
const MAX_RETRY_DELAY_MS = 10 * 60_000;
const CLAIMED_PAYLOAD = Symbol("approvalInteractionClaimedPayload");
const ALLOWED_FAILURE_CODES = new Set<string>(APPROVAL_INTERACTION_FAILURE_CODES);

const ENQUEUE_SCRIPT = `
-- approval-interaction:enqueue
local state = redis.call("HGET", KEYS[6], ARGV[1])
local payload = redis.call("HGET", KEYS[4], ARGV[1])
local active = payload and (
  (state == "ready" and redis.call("ZSCORE", KEYS[1], ARGV[1]))
  or (state == "delayed" and redis.call("ZSCORE", KEYS[2], ARGV[1]))
  or (state == "processing" and redis.call("ZSCORE", KEYS[3], ARGV[1]))
)
if active then return 0 end

redis.call("ZREM", KEYS[1], ARGV[1])
redis.call("ZREM", KEYS[2], ARGV[1])
redis.call("ZREM", KEYS[3], ARGV[1])
redis.call("HDEL", KEYS[7], ARGV[1])
redis.call("HSET", KEYS[4], ARGV[1], ARGV[2])
redis.call("HSET", KEYS[5], ARGV[1], ARGV[3])
redis.call("HSET", KEYS[6], ARGV[1], "ready")
redis.call("ZADD", KEYS[1], ARGV[3], ARGV[1])
return 1
`;

const CLAIM_SCRIPT = `
-- approval-interaction:claim
local expired = redis.call("ZRANGEBYSCORE", KEYS[3], "-inf", ARGV[3])
for _, id in ipairs(expired) do
  local payload = redis.call("HGET", KEYS[4], id)
  local received_at = redis.call("HGET", KEYS[5], id)
  if redis.call("HGET", KEYS[6], id) == "processing" and payload and received_at then
    redis.call("ZREM", KEYS[3], id)
    redis.call("HDEL", KEYS[7], id)
    redis.call("HSET", KEYS[6], id, "ready")
    redis.call("ZADD", KEYS[1], received_at, id)
  else
    redis.call("ZREM", KEYS[3], id)
    redis.call("HDEL", KEYS[4], id)
    redis.call("HDEL", KEYS[5], id)
    redis.call("HDEL", KEYS[6], id)
    redis.call("HDEL", KEYS[7], id)
  end
end

local due = redis.call("ZRANGEBYSCORE", KEYS[2], "-inf", ARGV[3])
for _, id in ipairs(due) do
  local payload = redis.call("HGET", KEYS[4], id)
  local received_at = redis.call("HGET", KEYS[5], id)
  if redis.call("HGET", KEYS[6], id) == "delayed" and payload and received_at then
    redis.call("ZREM", KEYS[2], id)
    redis.call("HSET", KEYS[6], id, "ready")
    redis.call("ZADD", KEYS[1], received_at, id)
  else
    redis.call("ZREM", KEYS[2], id)
    redis.call("HDEL", KEYS[4], id)
    redis.call("HDEL", KEYS[5], id)
    redis.call("HDEL", KEYS[6], id)
  end
end

local ready = redis.call("ZRANGE", KEYS[1], 0, tonumber(ARGV[1]) - 1)
local claimed = {}
for _, id in ipairs(ready) do
  local payload = redis.call("HGET", KEYS[4], id)
  if redis.call("HGET", KEYS[6], id) == "ready" and payload then
    redis.call("ZREM", KEYS[1], id)
    redis.call("ZADD", KEYS[3], ARGV[4], id)
    redis.call("HSET", KEYS[6], id, "processing")
    redis.call("HSET", KEYS[7], id, ARGV[2])
    table.insert(claimed, id)
    table.insert(claimed, payload)
  else
    redis.call("ZREM", KEYS[1], id)
    redis.call("HDEL", KEYS[4], id)
    redis.call("HDEL", KEYS[5], id)
    redis.call("HDEL", KEYS[6], id)
    redis.call("HDEL", KEYS[7], id)
  end
end
return claimed
`;

const ACK_SCRIPT = `
-- approval-interaction:ack
if redis.call("HGET", KEYS[6], ARGV[1]) ~= "processing"
  or redis.call("HGET", KEYS[7], ARGV[1]) ~= ARGV[3]
  or redis.call("HGET", KEYS[4], ARGV[1]) ~= ARGV[2]
  or not redis.call("ZSCORE", KEYS[3], ARGV[1]) then return 0 end
redis.call("ZREM", KEYS[1], ARGV[1])
redis.call("ZREM", KEYS[2], ARGV[1])
redis.call("ZREM", KEYS[3], ARGV[1])
redis.call("HDEL", KEYS[4], ARGV[1])
redis.call("HDEL", KEYS[5], ARGV[1])
redis.call("HDEL", KEYS[6], ARGV[1])
redis.call("HDEL", KEYS[7], ARGV[1])
return 1
`;

const ACK_INVALID_SCRIPT = `
-- approval-interaction:ack-invalid
if redis.call("HGET", KEYS[6], ARGV[1]) ~= "processing"
  or redis.call("HGET", KEYS[7], ARGV[1]) ~= ARGV[3]
  or redis.call("HGET", KEYS[4], ARGV[1]) ~= ARGV[2]
  or not redis.call("ZSCORE", KEYS[3], ARGV[1]) then return 0 end
redis.call("ZREM", KEYS[1], ARGV[1])
redis.call("ZREM", KEYS[2], ARGV[1])
redis.call("ZREM", KEYS[3], ARGV[1])
redis.call("HDEL", KEYS[4], ARGV[1])
redis.call("HDEL", KEYS[5], ARGV[1])
redis.call("HDEL", KEYS[6], ARGV[1])
redis.call("HDEL", KEYS[7], ARGV[1])
redis.call("HSET", KEYS[8], ARGV[4], ARGV[5])
redis.call("ZADD", KEYS[9], ARGV[6], ARGV[4])
redis.call("SADD", KEYS[10], ARGV[4])
redis.call("HDEL", KEYS[11], ARGV[4])
return 1
`;

const FAIL_SCRIPT = `
-- approval-interaction:fail
local exact = redis.call("HGET", KEYS[6], ARGV[1]) == "processing"
  and redis.call("HGET", KEYS[7], ARGV[1]) == ARGV[3]
  and redis.call("HGET", KEYS[4], ARGV[1]) == ARGV[2]
  and redis.call("ZSCORE", KEYS[3], ARGV[1])
if exact then
  redis.call("ZREM", KEYS[1], ARGV[1])
  redis.call("ZREM", KEYS[3], ARGV[1])
  redis.call("HDEL", KEYS[7], ARGV[1])
  if ARGV[5] == "delayed" then
    redis.call("HSET", KEYS[4], ARGV[1], ARGV[4])
    redis.call("HSET", KEYS[6], ARGV[1], "delayed")
    redis.call("ZADD", KEYS[2], ARGV[6], ARGV[1])
  else
    redis.call("ZREM", KEYS[2], ARGV[1])
    redis.call("HDEL", KEYS[4], ARGV[1])
    redis.call("HDEL", KEYS[5], ARGV[1])
    redis.call("HDEL", KEYS[6], ARGV[1])
    redis.call("HSET", KEYS[8], ARGV[7], ARGV[8])
    redis.call("ZADD", KEYS[9], ARGV[9], ARGV[7])
    redis.call("SADD", KEYS[10], ARGV[7])
    redis.call("HDEL", KEYS[11], ARGV[7])
  end
  return 1
end
if ARGV[5] == "delayed"
  and redis.call("HGET", KEYS[6], ARGV[1]) == "delayed"
  and redis.call("HGET", KEYS[4], ARGV[1]) == ARGV[4]
  and redis.call("ZSCORE", KEYS[2], ARGV[1]) then return 2 end
if ARGV[5] == "dead_letter"
  and redis.call("SISMEMBER", KEYS[10], ARGV[7]) == 1
  and redis.call("HGET", KEYS[8], ARGV[7]) == ARGV[8]
  and redis.call("ZSCORE", KEYS[9], ARGV[7]) then return 2 end
return 0
`;

const GET_COUNTS_SCRIPT = `
-- approval-interaction:get-counts
return {
  redis.call("ZCARD", KEYS[1]),
  redis.call("ZCARD", KEYS[2]),
  redis.call("ZCARD", KEYS[3]),
  redis.call("SCARD", KEYS[4])
}
`;

const LIST_DLQ_SCRIPT = `
-- approval-interaction:list-dlq
local ids = redis.call("ZRANGE", KEYS[2], 0, tonumber(ARGV[1]) - 1)
local listed = {}
for _, id in ipairs(ids) do
  local payload = redis.call("HGET", KEYS[1], id)
  if payload and redis.call("SISMEMBER", KEYS[3], id) == 1 then
    table.insert(listed, id)
    table.insert(listed, payload)
  end
end
return listed
`;

const FIND_DLQ_SCRIPT = `
-- approval-interaction:find-dlq
if redis.call("SISMEMBER", KEYS[3], ARGV[1]) == 1
  and redis.call("ZSCORE", KEYS[2], ARGV[1]) then
  local payload = redis.call("HGET", KEYS[1], ARGV[1])
  if payload then return { 1, payload } end
end
local outcome = redis.call("HGET", KEYS[4], ARGV[1])
if outcome == "replayed" then return { 2 } end
if outcome == "deleted" then return { 3 } end
return { 0 }
`;

const REPLAY_DLQ_SCRIPT = `
-- approval-interaction:replay-dlq
if redis.call("SISMEMBER", KEYS[10], ARGV[4]) ~= 1
  or not redis.call("ZSCORE", KEYS[9], ARGV[4])
  or redis.call("HGET", KEYS[8], ARGV[4]) ~= ARGV[5] then
  if redis.call("HGET", KEYS[11], ARGV[4]) == "replayed" then return 2 end
  return 0
end
local state = redis.call("HGET", KEYS[6], ARGV[1])
local active = redis.call("HGET", KEYS[4], ARGV[1]) and (
  (state == "ready" and redis.call("ZSCORE", KEYS[1], ARGV[1]))
  or (state == "delayed" and redis.call("ZSCORE", KEYS[2], ARGV[1]))
  or (state == "processing" and redis.call("ZSCORE", KEYS[3], ARGV[1]))
)
if not active then
  redis.call("ZREM", KEYS[1], ARGV[1])
  redis.call("ZREM", KEYS[2], ARGV[1])
  redis.call("ZREM", KEYS[3], ARGV[1])
  redis.call("HDEL", KEYS[7], ARGV[1])
  redis.call("HSET", KEYS[4], ARGV[1], ARGV[2])
  redis.call("HSET", KEYS[5], ARGV[1], ARGV[3])
  redis.call("HSET", KEYS[6], ARGV[1], "ready")
  redis.call("ZADD", KEYS[1], ARGV[3], ARGV[1])
end
redis.call("HDEL", KEYS[8], ARGV[4])
redis.call("ZREM", KEYS[9], ARGV[4])
redis.call("SREM", KEYS[10], ARGV[4])
redis.call("HSET", KEYS[11], ARGV[4], "replayed")
return 1
`;

const DELETE_DLQ_SCRIPT = `
-- approval-interaction:delete-dlq
if redis.call("SISMEMBER", KEYS[3], ARGV[1]) ~= 1
  or not redis.call("ZSCORE", KEYS[2], ARGV[1])
  or redis.call("HGET", KEYS[1], ARGV[1]) ~= ARGV[2] then
  if redis.call("HGET", KEYS[4], ARGV[1]) == "deleted" then return 2 end
  return 0
end
redis.call("HDEL", KEYS[1], ARGV[1])
redis.call("ZREM", KEYS[2], ARGV[1])
redis.call("SREM", KEYS[3], ARGV[1])
redis.call("HSET", KEYS[4], ARGV[1], "deleted")
return 1
`;

export type RedisApprovalInteractionQueueClient = {
  eval(
    script: string,
    options: { keys: string[]; arguments: string[] },
  ): Promise<number | string | Array<number | string> | null>;
};

export type RedisApprovalInteractionQueueOptions = {
  client: RedisApprovalInteractionQueueClient;
  prefix?: string;
  maxAttempts?: number;
  idGenerator?: () => string;
};

export class ApprovalInteractionQueueError extends Error {
  readonly code = "invalid_redis_reply" as const;

  constructor(operation: string) {
    super(`Invalid approval interaction Redis ${operation} reply`);
    this.name = "ApprovalInteractionQueueError";
  }
}

export function createRedisApprovalInteractionQueue({
  client,
  prefix = DEFAULT_PREFIX,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  idGenerator = randomUUID,
}: RedisApprovalInteractionQueueOptions): ApprovalInteractionQueue {
  const safePrefix = normalizeIdentifier(prefix, "prefix");
  const safeMaxAttempts = sanitizeMaxAttempts(maxAttempts);
  const keys = createKeys(safePrefix);
  const activeKeys = [
    keys.ready,
    keys.delayed,
    keys.processing,
    keys.members,
    keys.memberReceivedAt,
    keys.state,
    keys.processingOwners,
  ];
  const transitionKeys = [
    ...activeKeys,
    keys.deadLetterIndex,
    keys.deadLetterOrder,
    keys.deadLetterMembers,
    keys.deadLetterOutcomes,
  ];

  return {
    async enqueue(job) {
      const payload = serializeApprovalInteractionJob(job);
      const normalized = parseApprovalInteractionJob(payload);
      const result = await client.eval(ENQUEUE_SCRIPT, {
        keys: activeKeys,
        arguments: [
          normalized.idempotencyKey,
          payload,
          String(normalized.receivedAt.getTime()),
        ],
      });
      return readIntegerReply(result, [0, 1], "enqueue") === 1
        ? "enqueued"
        : "duplicate";
    },

    async claimBatch(input) {
      const limit = sanitizeLimit(input.limit);
      if (limit === 0) return [];
      const workerId = normalizeIdentifier(input.workerId, "workerId");
      const now = requireValidDate(input.now, "now");
      const leaseUntil = requireValidDate(input.leaseUntil, "leaseUntil");
      if (leaseUntil <= now) {
        throw new Error("leaseUntil must be after now");
      }
      const result = await client.eval(CLAIM_SCRIPT, {
        keys: activeKeys,
        arguments: [
          String(limit),
          workerId,
          String(now.getTime()),
          String(leaseUntil.getTime()),
        ],
      });
      const claimedPairs = readStringPairsReply(result, "claim");

      const jobs: ApprovalInteractionJob[] = [];
      for (const [id, payload] of claimedPairs) {
        try {
          const job = parseApprovalInteractionJob(payload);
          if (job.idempotencyKey !== id || job.attempts >= safeMaxAttempts) {
            throw new Error("Invalid approval interaction job payload");
          }
          Object.defineProperty(job, CLAIMED_PAYLOAD, {
            value: { id, payload },
          });
          jobs.push(job);
        } catch {
          const deadLetter = createInvalidPayloadDeadLetter({
            id: createGeneratedDeadLetterId(idGenerator()),
            payload,
            failedAt: now,
          });
          const quarantined = await client.eval(ACK_INVALID_SCRIPT, {
            keys: transitionKeys,
            arguments: [
              id,
              payload,
              workerId,
              deadLetter.id,
              serializeDeadLetter(deadLetter),
              String(now.getTime()),
            ],
          });
          if (readIntegerReply(quarantined, [0, 1], "quarantine") !== 1) {
            throw new Error("approval interaction quarantine transition did not match processing job");
          }
        }
      }
      return jobs;
    },

    async acknowledge(input) {
      const workerId = normalizeIdentifier(input.workerId, "workerId");
      const claimed = readClaimedPayload(input.job);
      const payload = claimed?.payload ?? serializeApprovalInteractionJob(input.job);
      const id = claimed?.id ?? parseApprovalInteractionJob(payload).idempotencyKey;
      const result = await client.eval(ACK_SCRIPT, {
        keys: activeKeys,
        arguments: [id, payload, workerId],
      });
      if (readIntegerReply(result, [0, 1], "acknowledge") !== 1) {
        throw new Error("approval interaction acknowledge transition did not match processing job");
      }
    },

    async handleFailure(input) {
      const workerId = normalizeIdentifier(input.workerId, "workerId");
      const failedAt = requireValidDate(input.at, "at");
      const claimed = readClaimedPayload(input.job);
      const originalPayload = claimed?.payload ?? serializeApprovalInteractionJob(input.job);
      const originalJob = parseApprovalInteractionJob(originalPayload);
      const id = claimed?.id ?? originalJob.idempotencyKey;
      const attempts = originalJob.attempts + 1;
      const failedJob = normalizeApprovalInteractionJob({ ...originalJob, attempts });
      const failedPayload = serializeApprovalInteractionJob(failedJob);
      const errorCode = normalizeErrorCode(input.errorCode);
      const deadLetterId = createTerminalDeadLetterId({ id, originalPayload, errorCode });
      const isTerminal = attempts >= safeMaxAttempts;
      const dueAt = failedAt.getTime() + retryDelayMs(attempts);
      const deadLetter: ApprovalInteractionJobDeadLetter = {
        id: deadLetterId,
        job: failedJob,
        errorCode,
        failedAt,
        replayable: true,
      };
      const result = await client.eval(FAIL_SCRIPT, {
        keys: transitionKeys,
        arguments: [
          id,
          originalPayload,
          workerId,
          failedPayload,
          isTerminal ? "dead_letter" : "delayed",
          String(dueAt),
          deadLetterId,
          serializeDeadLetter(deadLetter),
          String(failedAt.getTime()),
        ],
      });
      if (readIntegerReply(result, [0, 1, 2], "failure") === 0) {
        throw new Error("approval interaction failure transition did not match processing job");
      }
      return { action: isTerminal ? "dead_lettered" : "delayed" };
    },

    async getCounts() {
      const result = await client.eval(GET_COUNTS_SCRIPT, {
        keys: [keys.ready, keys.processing, keys.delayed, keys.deadLetterMembers],
        arguments: [],
      });
      const counts = readCountReply(result);
      return {
        pending: counts[0],
        processing: counts[1],
        delayed: counts[2],
        deadLetter: counts[3],
      };
    },

    async listDeadLetters(input) {
      const limit = sanitizeLimit(input.limit);
      if (limit === 0) return [];
      const result = await client.eval(LIST_DLQ_SCRIPT, {
        keys: [keys.deadLetterIndex, keys.deadLetterOrder, keys.deadLetterMembers],
        arguments: [String(limit)],
      });
      const listedPairs = readStringPairsReply(result, "dead-letter list");
      const deadLetters: ApprovalInteractionDeadLetter[] = [];
      for (const [id, payload] of listedPairs) {
        const parsed = parseDeadLetter(payload);
        if (parsed === undefined || parsed.id !== id) {
          throw new ApprovalInteractionQueueError("dead-letter payload");
        }
        deadLetters.push(parsed);
      }
      return deadLetters;
    },

    async replayDeadLetter(rawId) {
      const id = normalizeDeadLetterId(rawId);
      if (id === undefined) return "not_found";
      const payload = await findDeadLetter(client, keys, id);
      if (payload.status === "replayed") return "replayed";
      if (payload.status !== "active") return "not_found";
      const deadLetter = parseDeadLetter(payload.payload);
      if (deadLetter === undefined || deadLetter.id !== id) {
        throw new ApprovalInteractionQueueError("dead-letter payload");
      }
      if (!deadLetter.replayable) return "not_found";
      const replayJob = normalizeApprovalInteractionJob({ ...deadLetter.job, attempts: 0 });
      const replayPayload = serializeApprovalInteractionJob(replayJob);
      const result = await client.eval(REPLAY_DLQ_SCRIPT, {
        keys: transitionKeys,
        arguments: [
          replayJob.idempotencyKey,
          replayPayload,
          String(replayJob.receivedAt.getTime()),
          id,
          payload.payload,
        ],
      });
      return readIntegerReply(result, [0, 1, 2], "dead-letter replay") !== 0
        ? "replayed"
        : "not_found";
    },

    async deleteDeadLetter(rawId) {
      const id = normalizeDeadLetterId(rawId);
      if (id === undefined) return "not_found";
      const payload = await findDeadLetter(client, keys, id);
      if (payload.status === "deleted") return "deleted";
      if (payload.status !== "active") return "not_found";
      const result = await client.eval(DELETE_DLQ_SCRIPT, {
        keys: [
          keys.deadLetterIndex,
          keys.deadLetterOrder,
          keys.deadLetterMembers,
          keys.deadLetterOutcomes,
        ],
        arguments: [id, payload.payload],
      });
      return readIntegerReply(result, [0, 1, 2], "dead-letter delete") !== 0
        ? "deleted"
        : "not_found";
    },
  };
}

export function serializeApprovalInteractionJob(job: ApprovalInteractionJob): string {
  const normalized = normalizeApprovalInteractionJob(job);
  return JSON.stringify({
    ...normalized,
    receivedAt: normalized.receivedAt.toISOString(),
  });
}

export function parseApprovalInteractionJob(payload: string): ApprovalInteractionJob {
  try {
    return normalizeApprovalInteractionJob(JSON.parse(payload));
  } catch {
    throw new Error("Invalid approval interaction job payload");
  }
}

type ApprovalInteractionKeys = ReturnType<typeof createKeys>;

function createKeys(prefix: string) {
  return {
    ready: `${prefix}:ready`,
    delayed: `${prefix}:delayed`,
    processing: `${prefix}:processing`,
    members: `${prefix}:members`,
    memberReceivedAt: `${prefix}:member:received-at`,
    state: `${prefix}:state`,
    processingOwners: `${prefix}:processing:owners`,
    deadLetterIndex: `${prefix}:dlq:index`,
    deadLetterOrder: `${prefix}:dlq:order`,
    deadLetterMembers: `${prefix}:dlq:members`,
    deadLetterOutcomes: `${prefix}:dlq:outcomes`,
  };
}

function readClaimedPayload(job: ApprovalInteractionJob): { id: string; payload: string } | undefined {
  return (job as ApprovalInteractionJob & {
    [CLAIMED_PAYLOAD]?: { id: string; payload: string };
  })[CLAIMED_PAYLOAD];
}

async function findDeadLetter(
  client: RedisApprovalInteractionQueueClient,
  keys: ApprovalInteractionKeys,
  id: string,
): Promise<
  | { status: "not_found" | "replayed" | "deleted" }
  | { status: "active"; payload: string }
> {
  const result = await client.eval(FIND_DLQ_SCRIPT, {
    keys: [
      keys.deadLetterIndex,
      keys.deadLetterOrder,
      keys.deadLetterMembers,
      keys.deadLetterOutcomes,
    ],
    arguments: [id],
  });
  if (!Array.isArray(result)) {
    throw new ApprovalInteractionQueueError("dead-letter find");
  }
  if (result.length === 1 && result[0] === 0) return { status: "not_found" };
  if (result.length === 1 && result[0] === 2) return { status: "replayed" };
  if (result.length === 1 && result[0] === 3) return { status: "deleted" };
  if (result.length === 2 && result[0] === 1 && typeof result[1] === "string") {
    return { status: "active", payload: result[1] };
  }
  throw new ApprovalInteractionQueueError("dead-letter find");
}

function serializeDeadLetter(deadLetter: ApprovalInteractionDeadLetter): string {
  if (deadLetter.replayable) {
    return JSON.stringify({
      ...deadLetter,
      job: JSON.parse(serializeApprovalInteractionJob(deadLetter.job)),
      failedAt: deadLetter.failedAt.toISOString(),
    });
  }
  return JSON.stringify({ ...deadLetter, failedAt: deadLetter.failedAt.toISOString() });
}

function parseDeadLetter(payload: string): ApprovalInteractionDeadLetter | undefined {
  try {
    const parsed: unknown = JSON.parse(payload);
    if (!isRecord(parsed) || typeof parsed.id !== "string" ||
        normalizeDeadLetterId(parsed.id) !== parsed.id ||
        typeof parsed.errorCode !== "string" || typeof parsed.failedAt !== "string") {
      return undefined;
    }
    const failedAt = parseIsoDate(parsed.failedAt);
    if (parsed.replayable === true) {
      return {
        id: parsed.id,
        job: normalizeApprovalInteractionJob(parsed.job),
        errorCode: normalizeErrorCode(parsed.errorCode),
        failedAt,
        replayable: true,
      };
    }
    if (parsed.replayable === false && parsed.errorCode === "invalid_queue_payload" &&
        typeof parsed.payloadDigest === "string" &&
        Number.isSafeInteger(parsed.payloadBytes) && Number(parsed.payloadBytes) >= 0) {
      return {
        id: parsed.id,
        payloadDigest: parsed.payloadDigest,
        payloadBytes: Number(parsed.payloadBytes),
        errorCode: "invalid_queue_payload",
        failedAt,
        replayable: false,
      };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function createInvalidPayloadDeadLetter(input: {
  id: string;
  payload: string;
  failedAt: Date;
}): ApprovalInteractionInvalidPayloadDeadLetter {
  return {
    id: input.id,
    payloadDigest: `sha256:${createHash("sha256").update(input.payload).digest("hex")}`,
    payloadBytes: Buffer.byteLength(input.payload),
    errorCode: "invalid_queue_payload",
    failedAt: input.failedAt,
    replayable: false,
  };
}

function createGeneratedDeadLetterId(seed: string): string {
  return `dlq:${createHash("sha256").update(seed).digest("hex")}`;
}

function createTerminalDeadLetterId(input: {
  id: string;
  originalPayload: string;
  errorCode: string;
}): string {
  return createGeneratedDeadLetterId(`${input.id}\0${input.originalPayload}\0${input.errorCode}`);
}

function retryDelayMs(attempts: number): number {
  return RETRY_DELAYS_MS[attempts - 1] ?? MAX_RETRY_DELAY_MS;
}

function normalizeErrorCode(value: string): ApprovalInteractionFailureCode {
  return typeof value === "string" && ALLOWED_FAILURE_CODES.has(value)
    ? value as ApprovalInteractionFailureCode
    : "internal_error";
}

function normalizeDeadLetterId(value: string): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return /^dlq:[a-f0-9]{64}$/u.test(normalized) ? normalized : undefined;
}

function normalizeIdentifier(value: string, fieldName: string): string {
  if (typeof value !== "string") throw new Error(`${fieldName} must be a string`);
  const normalized = value.trim();
  if (normalized.length === 0) throw new Error(`${fieldName} must be nonblank`);
  if (normalized.length > MAX_IDENTIFIER_CHARS) {
    throw new Error(`${fieldName} must be at most ${MAX_IDENTIFIER_CHARS} characters`);
  }
  return normalized;
}

function sanitizeLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("limit must be a nonnegative safe integer");
  }
  return Math.min(value, MAX_QUEUE_LIMIT);
}

function sanitizeMaxAttempts(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value >= Number.MAX_SAFE_INTEGER) {
    throw new Error("maxAttempts must be a positive safe integer below Number.MAX_SAFE_INTEGER");
  }
  return value;
}

function readIntegerReply<const T extends readonly number[]>(
  value: unknown,
  allowed: T,
  operation: string,
): T[number] {
  if (typeof value !== "number" || !Number.isSafeInteger(value) ||
      !allowed.includes(value)) {
    throw new ApprovalInteractionQueueError(operation);
  }
  return value as T[number];
}

function readStringPairsReply(value: unknown, operation: string): Array<[string, string]> {
  if (!Array.isArray(value) || value.length % 2 !== 0 ||
      value.some((item) => typeof item !== "string")) {
    throw new ApprovalInteractionQueueError(operation);
  }
  const pairs: Array<[string, string]> = [];
  for (let index = 0; index < value.length; index += 2) {
    pairs.push([value[index] as string, value[index + 1] as string]);
  }
  return pairs;
}

function readCountReply(value: unknown): [number, number, number, number] {
  if (!Array.isArray(value) || value.length !== 4 ||
      value.some((count) => typeof count !== "number" ||
        !Number.isSafeInteger(count) || count < 0)) {
    throw new ApprovalInteractionQueueError("count");
  }
  return value as [number, number, number, number];
}

function requireValidDate(value: Date, fieldName: string): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error(`${fieldName} must be a valid date`);
  }
  return new Date(value.getTime());
}

function parseIsoDate(value: string): Date {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new Error("invalid ISO date");
  }
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
