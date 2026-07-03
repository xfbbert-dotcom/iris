import type {
  RawEvent,
  RawEventFailureInput,
  RawEventFailureResult,
  RawEventQueue,
} from "./raw-event-queue.js";

const DEFAULT_SEEN_KEY = "iris:events:raw:seen";
const DEFAULT_QUEUE_KEY = "iris:events:raw:queue";
const DEFAULT_DEAD_LETTER_KEY = "iris:events:raw:dlq";
const DEFAULT_MAX_ATTEMPTS = 3;

const ENQUEUE_SCRIPT = `
if redis.call("SADD", KEYS[1], ARGV[1]) == 1 then
  return redis.call("RPUSH", KEYS[2], ARGV[2])
end
return 0
`;

export type RedisRawEventQueueClient = {
  eval(
    script: string,
    options: { keys: string[]; arguments: string[] },
  ): Promise<number | string>;
  rPush(key: string, value: string): Promise<number>;
  lPop(key: string): Promise<string | null>;
  lLen(key: string): Promise<number>;
  sRem(key: string, member: string): Promise<number>;
};

export type RedisRawEventQueueOptions = {
  client: RedisRawEventQueueClient;
  seenKey?: string;
  queueKey?: string;
  deadLetterKey?: string;
  maxAttempts?: number;
  now?: () => Date;
};

export function createRedisRawEventQueue({
  client,
  seenKey = DEFAULT_SEEN_KEY,
  queueKey = DEFAULT_QUEUE_KEY,
  deadLetterKey = DEFAULT_DEAD_LETTER_KEY,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  now = () => new Date(),
}: RedisRawEventQueueOptions): RawEventQueue {
  const safeMaxAttempts = sanitizeMaxAttempts(maxAttempts);

  return {
    async enqueue(event) {
      await enqueueSerializedRawEvent(client, seenKey, queueKey, event);
    },

    async dequeueBatch(limit) {
      const safeLimit = sanitizeLimit(limit);
      const events: RawEvent[] = [];

      for (let index = 0; index < safeLimit; index += 1) {
        const payload = await client.lPop(queueKey);
        if (payload === null) {
          break;
        }

        try {
          const event = parseRawEvent(payload);
          await client.sRem(seenKey, event.idempotencyKey);
          events.push(event);
        } catch (error) {
          await client.rPush(
            deadLetterKey,
            JSON.stringify({
              rawPayload: payload,
              errorMessage: error instanceof Error ? error.message : String(error),
              failedAt: now().toISOString(),
            }),
          );
        }
      }

      return events;
    },

    async handleFailedEvent(input: RawEventFailureInput): Promise<RawEventFailureResult> {
      const attempts = input.event.attempts + 1;
      const failedEvent = { ...input.event, attempts };

      if (attempts >= safeMaxAttempts) {
        await client.rPush(
          deadLetterKey,
          JSON.stringify({
            event: serializeRawEventPayload(failedEvent),
            errorMessage: input.errorMessage,
            failedAt: now().toISOString(),
          }),
        );
        return { action: "dead_lettered", attempts };
      }

      await enqueueSerializedRawEvent(client, seenKey, queueKey, failedEvent);
      return { action: "requeued", attempts };
    },

    getPendingCount() {
      return client.lLen(queueKey);
    },

    getDeadLetterCount() {
      return client.lLen(deadLetterKey);
    },
  };
}

async function enqueueSerializedRawEvent(
  client: RedisRawEventQueueClient,
  seenKey: string,
  queueKey: string,
  event: RawEvent,
): Promise<void> {
  await client.eval(ENQUEUE_SCRIPT, {
    keys: [seenKey, queueKey],
    arguments: [event.idempotencyKey, serializeRawEvent(event)],
  });
}

export function serializeRawEvent(event: RawEvent): string {
  return JSON.stringify(serializeRawEventPayload(event));
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
  const parsedAttempts = readOptionalNonNegativeInteger(parsed.attempts);
  const attempts = parsedAttempts ?? 0;
  if (
    readString(parsed.idempotencyKey).length === 0 ||
    parsed.provider !== "feishu" ||
    readString(parsed.eventType).length === 0 ||
    !isRecord(parsed.rawBody) ||
    Number.isNaN(receivedAt.getTime()) ||
    parsedAttempts === null
  ) {
    throw new Error("Invalid raw event payload");
  }

  return {
    idempotencyKey: readString(parsed.idempotencyKey),
    provider: "feishu",
    eventType: readString(parsed.eventType),
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

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
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
