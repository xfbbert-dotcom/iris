import type {
  RawEvent,
  RawEventDeadLetter,
  RawEventFailureInput,
  RawEventFailureResult,
  RawEventQueue,
  ReplayRawEventDeadLettersResult,
} from "./raw-event-queue.js";
import {
  createRawEventIdempotencyKey,
  MAX_RAW_EVENT_IDEMPOTENCY_KEY_LENGTH,
  MAX_RAW_EVENT_ID_LENGTH,
  MAX_RAW_EVENT_QUEUE_LIMIT,
} from "./raw-event-queue.js";
import { normalizeDeadLetterErrorMessage } from "../queues/dead-letter-error-message.js";

const DEFAULT_SEEN_KEY = "iris:events:raw:seen";
const DEFAULT_QUEUE_KEY = "iris:events:raw:queue";
const DEFAULT_PROCESSING_KEY = "iris:events:raw:processing";
const DEFAULT_DEAD_LETTER_KEY = "iris:events:raw:dlq";
const DEFAULT_MAX_ATTEMPTS = 3;
const FEISHU_RAW_EVENT_IDEMPOTENCY_KEY_PREFIX = createRawEventIdempotencyKey({
  provider: "feishu",
  eventId: "event",
}).slice(0, -"event".length);

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

export type RedisRawEventQueueClient = {
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

export type RedisRawEventQueueOptions = {
  client: RedisRawEventQueueClient;
  seenKey?: string;
  queueKey?: string;
  processingKey?: string;
  deadLetterKey?: string;
  maxAttempts?: number;
  now?: () => Date;
  idGenerator?: () => string;
};

export function createRedisRawEventQueue({
  client,
  seenKey = DEFAULT_SEEN_KEY,
  queueKey = DEFAULT_QUEUE_KEY,
  processingKey = DEFAULT_PROCESSING_KEY,
  deadLetterKey = DEFAULT_DEAD_LETTER_KEY,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  now = () => new Date(),
  idGenerator = defaultIdGenerator,
}: RedisRawEventQueueOptions): RawEventQueue {
  const safeMaxAttempts = sanitizeMaxAttempts(maxAttempts);

  const replayDeadLetter = async (
    id: string,
  ): Promise<"replayed" | "not_found" | "unsupported_legacy_item"> => {
    const found = await findDeadLetterByStoredId(client, deadLetterKey, id, now);
    if (found === undefined) {
      return id.startsWith("legacy:") ? "unsupported_legacy_item" : "not_found";
    }

    if (!("event" in found.deadLetter) || !found.deadLetter.replayable) {
      return "unsupported_legacy_item";
    }

    await upsertRetryingSerializedRawEvent(client, seenKey, queueKey, {
      ...found.deadLetter.event,
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
    async enqueue(event) {
      await enqueueSerializedRawEvent(client, seenKey, queueKey, event);
    },

    async dequeueBatch(limit) {
      const safeLimit = sanitizeLimit(limit);
      const events: RawEvent[] = [];

      await recoverProcessingEventsIfPresent(client, processingKey, queueKey);
      for (let index = 0; index < safeLimit; index += 1) {
        const payload = await dequeueSerializedRawEvent(client, queueKey, processingKey);
        if (payload === null) {
          break;
        }

        try {
          const event = parseRawEvent(payload);
          events.push(event);
        } catch (error) {
          const idempotencyKey = readQueuedRawEventIdempotencyKey(payload);
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

      return events;
    },

    async handleProcessedEvent(event: RawEvent): Promise<void> {
      const payload = serializeRawEvent(event);
      const normalizedEvent = parseRawEvent(payload);
      await client.lRem(processingKey, 1, payload);
      await client.sRem(seenKey, normalizedEvent.idempotencyKey);
    },

    async handleFailedEvent(input: RawEventFailureInput): Promise<RawEventFailureResult> {
      const attempts = input.event.attempts + 1;
      const failedEvent = { ...input.event, attempts };
      const originalPayload = serializeRawEvent(input.event);

      if (attempts >= safeMaxAttempts) {
        await client.rPush(
          deadLetterKey,
          serializeDeadLetteredRawEvent({
            id: idGenerator(),
            event: failedEvent,
            errorMessage: input.errorMessage,
            failedAt: now(),
          }),
        );
        await client.lRem(processingKey, 1, originalPayload);
        await client.sRem(seenKey, parseRawEvent(originalPayload).idempotencyKey);
        return { action: "dead_lettered", attempts };
      }

      await upsertRetryingSerializedRawEvent(client, seenKey, queueKey, failedEvent);
      await client.lRem(processingKey, 1, originalPayload);
      return { action: "requeued", attempts };
    },

    getPendingCount() {
      return client.lLen(queueKey);
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

    async replayDeadLetters(input): Promise<ReplayRawEventDeadLettersResult> {
      const result: ReplayRawEventDeadLettersResult = {
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

async function enqueueSerializedRawEvent(
  client: RedisRawEventQueueClient,
  seenKey: string,
  queueKey: string,
  event: RawEvent,
): Promise<void> {
  const payload = serializeRawEvent(event);
  const normalizedEvent = parseRawEvent(payload);
  await client.eval(ENQUEUE_SCRIPT, {
    keys: [seenKey, queueKey],
    arguments: [normalizedEvent.idempotencyKey, payload],
  });
}

async function recoverProcessingEventsIfPresent(
  client: RedisRawEventQueueClient,
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

async function dequeueSerializedRawEvent(
  client: RedisRawEventQueueClient,
  queueKey: string,
  processingKey: string,
): Promise<string | null> {
  const result = await client.eval(DEQUEUE_SCRIPT, {
    keys: [queueKey, processingKey],
    arguments: [],
  });

  return typeof result === "string" ? result : null;
}

async function upsertRetryingSerializedRawEvent(
  client: RedisRawEventQueueClient,
  seenKey: string,
  queueKey: string,
  event: RawEvent,
): Promise<void> {
  const payload = serializeRawEvent(event);
  const normalizedEvent = parseRawEvent(payload);
  await client.eval(UPSERT_RETRY_SCRIPT, {
    keys: [seenKey, queueKey],
    arguments: [normalizedEvent.idempotencyKey, payload],
  });
}

export function serializeRawEvent(event: RawEvent): string {
  return JSON.stringify(serializeRawEventPayload(normalizeRawEvent(event)));
}

export function parseRawEvent(payload: string): RawEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw new Error("Invalid raw event JSON");
  }

  if (!isRecord(parsed)) {
    throw new Error("Invalid raw event payload");
  }

  const receivedAt = new Date(readString(parsed.receivedAt));
  const idempotencyKey = readString(parsed.idempotencyKey);
  const eventType = readString(parsed.eventType);
  const parsedAttempts = readOptionalNonNegativeInteger(parsed.attempts);
  const attempts = parsedAttempts ?? 0;
  if (
    idempotencyKey.length === 0 ||
    idempotencyKey.length > MAX_RAW_EVENT_IDEMPOTENCY_KEY_LENGTH ||
    parsed.provider !== "feishu" ||
    eventType.length === 0 ||
    eventType.length > MAX_RAW_EVENT_ID_LENGTH ||
    !isRecord(parsed.rawBody) ||
    Number.isNaN(receivedAt.getTime()) ||
    parsedAttempts === null
  ) {
    throw new Error("Invalid raw event payload");
  }

  return {
    idempotencyKey,
    provider: "feishu",
    eventType,
    rawBody: parsed.rawBody,
    receivedAt,
    attempts,
  };
}

function serializeRawEventPayload(event: RawEvent): Record<string, unknown> {
  return {
    ...event,
    receivedAt: event.receivedAt.toISOString(),
  };
}

function normalizeRawEvent(event: RawEvent): RawEvent {
  return parseRawEvent(JSON.stringify(serializeRawEventPayload(event)));
}

function serializeDeadLetteredRawEvent(input: {
  id: string;
  event: RawEvent;
  errorMessage: string;
  failedAt: Date;
}): string {
  const event = normalizeRawEvent(input.event);
  return JSON.stringify({
    id: input.id,
    event: serializeRawEventPayload(event),
    errorMessage: normalizeDeadLetterErrorMessage(input.errorMessage),
    failedAt: input.failedAt.toISOString(),
  });
}

type ParsedDeadLetterPayload = {
  payload: string;
  deadLetter: RawEventDeadLetter;
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
      errorMessage: "Invalid raw event dead letter JSON",
      failedAt: now(),
    });
  }

  if (!isRecord(parsed)) {
    return createInvalidDeadLetterDiagnostic({
      payload,
      index,
      errorMessage: "Invalid raw event dead letter payload",
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
      errorMessage: "Invalid raw event dead letter payload",
      failedAt: now(),
    });
  }

  if (!isRecord(parsed.event)) {
    const rawPayload = readRawPayload(parsed.rawPayload);
    if (rawPayload === undefined) {
      return createInvalidDeadLetterDiagnostic({
        payload,
        index,
        storedId,
        errorMessage: "Invalid raw event dead letter payload",
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

  let event: RawEvent;
  try {
    event = parseRawEvent(JSON.stringify(parsed.event));
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
      event,
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
  client: RedisRawEventQueueClient,
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

function readQueuedRawEventIdempotencyKey(payload: string): string | undefined {
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
  if (
    parsed.provider !== "feishu" ||
    idempotencyKey.length === 0 ||
    idempotencyKey.length > MAX_RAW_EVENT_IDEMPOTENCY_KEY_LENGTH ||
    !isFeishuRawEventIdempotencyKey(idempotencyKey)
  ) {
    return undefined;
  }

  return idempotencyKey;
}

function isFeishuRawEventIdempotencyKey(idempotencyKey: string): boolean {
  return (
    idempotencyKey.startsWith(FEISHU_RAW_EVENT_IDEMPOTENCY_KEY_PREFIX) &&
    idempotencyKey.length > FEISHU_RAW_EVENT_IDEMPOTENCY_KEY_PREFIX.length
  );
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
    throw new Error("raw event queue limit must be a finite safe-magnitude number");
  }

  return Math.min(MAX_RAW_EVENT_QUEUE_LIMIT, Math.max(0, Math.floor(value)));
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
