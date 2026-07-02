# Iris Feishu Raw Event Queue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Redis-backed raw Feishu event queue and worker foundation so Feishu callbacks can stay ack-first while downstream processing becomes retryable and observable.

**Architecture:** Introduce a new `events` module parallel to the existing `reindex` module: queue contract, in-memory queue, Redis queue, worker, loop, and runtime composer. Wire Feishu Gateway to enqueue `RawEvent` objects without changing external callback behavior, then expose worker status through an internal API.

**Tech Stack:** TypeScript, Fastify, Vitest, Redis list/set operations, existing Iris runtime/env patterns.

---

## File Structure

- Create `apps/core/src/events/raw-event-queue.ts`: raw event types and queue interface.
- Create `apps/core/src/events/in-memory-raw-event-queue.ts`: test-friendly queue implementation.
- Create `apps/core/src/events/redis-raw-event-queue.ts`: Redis-backed queue implementation.
- Create `apps/core/src/events/raw-event-worker.ts`: batch worker with per-event retry handling.
- Create `apps/core/src/events/raw-event-worker-loop.ts`: polling loop and latest batch snapshot.
- Create `apps/core/src/runtime/event-worker-runtime.ts`: Redis/no-op processor runtime composer.
- Modify `apps/core/src/config/env.ts`: event worker runtime config.
- Modify `apps/core/src/feishu/feishu-gateway.ts`: enqueue `RawEvent`.
- Modify `apps/core/src/app.ts`: compose event runtime and add `/internal/events/status`.
- Add tests under `apps/core/tests/*`.

## Task 1: Raw Event Queue Contract And Implementations

**Files:**
- Create: `apps/core/src/events/raw-event-queue.ts`
- Create: `apps/core/src/events/in-memory-raw-event-queue.ts`
- Create: `apps/core/src/events/redis-raw-event-queue.ts`
- Test: `apps/core/tests/raw-event-queue.test.ts`
- Test: `apps/core/tests/redis-raw-event-queue.test.ts`

- [ ] **Step 1: Write in-memory queue tests**

Create `apps/core/tests/raw-event-queue.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import {
  createRawEventIdempotencyKey,
  type RawEvent,
} from "../src/events/raw-event-queue.js";
import { InMemoryRawEventQueue } from "../src/events/in-memory-raw-event-queue.js";

describe("InMemoryRawEventQueue", () => {
  it("deduplicates events by idempotency key", async () => {
    const queue = new InMemoryRawEventQueue();
    const event = eventFixture();

    await queue.enqueue(event);
    await queue.enqueue({ ...event, receivedAt: new Date("2026-07-02T02:00:00.000Z") });

    await expect(queue.dequeueBatch(10)).resolves.toEqual([event]);
  });

  it("dequeues events in FIFO order", async () => {
    const queue = new InMemoryRawEventQueue();
    const first = eventFixture({ idempotencyKey: "feishu:event-1" });
    const second = eventFixture({ idempotencyKey: "feishu:event-2" });

    await queue.enqueue(first);
    await queue.enqueue(second);

    await expect(queue.dequeueBatch(1)).resolves.toEqual([first]);
    await expect(queue.dequeueBatch(10)).resolves.toEqual([second]);
  });

  it("creates stable idempotency keys", () => {
    expect(createRawEventIdempotencyKey({ provider: "feishu", eventId: "evt-1" })).toBe(
      "raw-event:feishu:evt-1",
    );
  });

  it("requeues failed events below max attempts", async () => {
    const queue = new InMemoryRawEventQueue({ maxAttempts: 3 });
    const event = eventFixture();

    await expect(
      queue.handleFailedEvent({ event, errorMessage: "processor failed" }),
    ).resolves.toEqual({ action: "requeued", attempts: 1 });
    await expect(queue.dequeueBatch(1)).resolves.toEqual([{ ...event, attempts: 1 }]);
    await expect(queue.getDeadLetterCount()).resolves.toBe(0);
  });

  it("moves failed events to DLQ at max attempts", async () => {
    const queue = new InMemoryRawEventQueue({ maxAttempts: 3 });
    const event = eventFixture({ attempts: 2 });

    await expect(
      queue.handleFailedEvent({ event, errorMessage: "processor failed" }),
    ).resolves.toEqual({ action: "dead_lettered", attempts: 3 });
    await expect(queue.dequeueBatch(1)).resolves.toEqual([]);
    await expect(queue.getDeadLetterCount()).resolves.toBe(1);
  });
});

function eventFixture(overrides: Partial<RawEvent> = {}): RawEvent {
  return {
    idempotencyKey: "raw-event:feishu:event-1",
    provider: "feishu",
    eventType: "im.message.receive_v1",
    rawBody: { event_id: "event-1" },
    receivedAt: new Date("2026-07-02T01:00:00.000Z"),
    attempts: 0,
    ...overrides,
  };
}
```

- [ ] **Step 2: Run in-memory test to verify it fails**

Run:

```powershell
npm --workspace apps/core test -- raw-event-queue.test.ts
```

Expected: FAIL because files do not exist.

- [ ] **Step 3: Implement raw event queue contract**

Create `apps/core/src/events/raw-event-queue.ts`:

```ts
export type RawEventProvider = "feishu";

export type RawEvent = {
  idempotencyKey: string;
  provider: RawEventProvider;
  eventType: string;
  rawBody: unknown;
  receivedAt: Date;
  attempts: number;
};

export type RawEventFailureInput = {
  event: RawEvent;
  errorMessage: string;
};

export type RawEventFailureResult = {
  action: "requeued" | "dead_lettered";
  attempts: number;
};

export type CreateRawEventIdempotencyKeyInput = {
  provider: RawEventProvider;
  eventId: string;
};

export interface RawEventQueue {
  enqueue(event: RawEvent): Promise<void>;
  dequeueBatch(limit: number): Promise<RawEvent[]>;
  handleFailedEvent(input: RawEventFailureInput): Promise<RawEventFailureResult>;
  getPendingCount(): Promise<number>;
  getDeadLetterCount(): Promise<number>;
}

export function createRawEventIdempotencyKey(input: CreateRawEventIdempotencyKeyInput): string {
  return `raw-event:${input.provider}:${input.eventId}`;
}
```

- [ ] **Step 4: Implement in-memory queue**

Create `apps/core/src/events/in-memory-raw-event-queue.ts`:

```ts
import type {
  RawEvent,
  RawEventFailureInput,
  RawEventFailureResult,
  RawEventQueue,
} from "./raw-event-queue.js";

const DEFAULT_MAX_ATTEMPTS = 3;

type DeadLetteredRawEvent = {
  event: RawEvent;
  errorMessage: string;
  failedAt: Date;
};

export type InMemoryRawEventQueueOptions = {
  maxAttempts?: number;
  now?: () => Date;
};

export class InMemoryRawEventQueue implements RawEventQueue {
  private readonly events: RawEvent[] = [];
  private readonly deadLetters: DeadLetteredRawEvent[] = [];
  private readonly seenKeys = new Set<string>();
  private readonly maxAttempts: number;
  private readonly now: () => Date;

  constructor(options: InMemoryRawEventQueueOptions = {}) {
    this.maxAttempts = sanitizeMaxAttempts(options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
    this.now = options.now ?? (() => new Date());
  }

  async enqueue(event: RawEvent): Promise<void> {
    if (this.seenKeys.has(event.idempotencyKey)) {
      return;
    }

    this.seenKeys.add(event.idempotencyKey);
    this.events.push(event);
  }

  async dequeueBatch(limit: number): Promise<RawEvent[]> {
    const safeLimit = Math.max(0, Math.floor(limit));
    return this.events.splice(0, safeLimit);
  }

  async handleFailedEvent(input: RawEventFailureInput): Promise<RawEventFailureResult> {
    const attempts = input.event.attempts + 1;
    const failedEvent = { ...input.event, attempts };

    if (attempts >= this.maxAttempts) {
      this.deadLetters.push({
        event: failedEvent,
        errorMessage: input.errorMessage,
        failedAt: this.now(),
      });
      return { action: "dead_lettered", attempts };
    }

    this.events.push(failedEvent);
    return { action: "requeued", attempts };
  }

  async getPendingCount(): Promise<number> {
    return this.events.length;
  }

  async getDeadLetterCount(): Promise<number> {
    return this.deadLetters.length;
  }
}

function sanitizeMaxAttempts(value: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error("maxAttempts must be a positive integer");
  }

  return value;
}
```

- [ ] **Step 5: Write Redis queue tests**

Create `apps/core/tests/redis-raw-event-queue.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";

import {
  createRawEventIdempotencyKey,
  type RawEvent,
} from "../src/events/raw-event-queue.js";
import {
  createRedisRawEventQueue,
  parseRawEvent,
  serializeRawEvent,
  type RedisRawEventQueueClient,
} from "../src/events/redis-raw-event-queue.js";

describe("RedisRawEventQueue", () => {
  it("atomically enqueues raw events through Redis eval", async () => {
    const client: RedisRawEventQueueClient = {
      eval: vi.fn(async () => 1),
      rPush: vi.fn(),
      lPop: vi.fn(),
      lLen: vi.fn(),
    };
    const queue = createRedisRawEventQueue({ client });
    const event = eventFixture();

    await queue.enqueue(event);

    expect(client.eval).toHaveBeenCalledWith(expect.stringContaining("SADD"), {
      keys: ["iris:events:raw:seen", "iris:events:raw:queue"],
      arguments: [event.idempotencyKey, serializeRawEvent(event)],
    });
  });

  it("round-trips raw event dates through JSON", () => {
    const event = eventFixture();

    expect(parseRawEvent(serializeRawEvent(event))).toEqual(event);
  });

  it("defaults missing attempts to zero for old payloads", () => {
    const { attempts: _attempts, ...legacyEvent } = {
      ...eventFixture(),
      receivedAt: "2026-07-02T01:00:00.000Z",
    };

    expect(parseRawEvent(JSON.stringify(legacyEvent))).toEqual(eventFixture());
  });

  it("dequeues raw events in FIFO order up to limit", async () => {
    const first = eventFixture({ idempotencyKey: "raw-event:feishu:event-1" });
    const second = eventFixture({ idempotencyKey: "raw-event:feishu:event-2" });
    const client: RedisRawEventQueueClient = {
      eval: vi.fn(),
      rPush: vi.fn(),
      lLen: vi.fn(),
      lPop: vi
        .fn()
        .mockResolvedValueOnce(serializeRawEvent(first))
        .mockResolvedValueOnce(serializeRawEvent(second))
        .mockResolvedValueOnce(null),
    };
    const queue = createRedisRawEventQueue({ client });

    await expect(queue.dequeueBatch(10)).resolves.toEqual([first, second]);
  });

  it("requeues failed raw events below max attempts", async () => {
    const client: RedisRawEventQueueClient = {
      eval: vi.fn(),
      rPush: vi.fn(async () => 1),
      lPop: vi.fn(),
      lLen: vi.fn(),
    };
    const queue = createRedisRawEventQueue({ client, maxAttempts: 3 });
    const event = eventFixture();

    await expect(
      queue.handleFailedEvent({ event, errorMessage: "processor failed" }),
    ).resolves.toEqual({ action: "requeued", attempts: 1 });
    expect(client.rPush).toHaveBeenCalledWith(
      "iris:events:raw:queue",
      serializeRawEvent({ ...event, attempts: 1 }),
    );
  });

  it("moves failed raw events to Redis DLQ at max attempts", async () => {
    const client: RedisRawEventQueueClient = {
      eval: vi.fn(),
      rPush: vi.fn(async () => 1),
      lPop: vi.fn(),
      lLen: vi.fn(async () => 5),
    };
    const queue = createRedisRawEventQueue({ client, maxAttempts: 3 });
    const event = eventFixture({ attempts: 2 });

    await expect(
      queue.handleFailedEvent({ event, errorMessage: "processor failed" }),
    ).resolves.toEqual({ action: "dead_lettered", attempts: 3 });
    expect(client.rPush).toHaveBeenCalledWith(
      "iris:events:raw:dlq",
      expect.stringContaining("processor failed"),
    );
    await expect(queue.getDeadLetterCount()).resolves.toBe(5);
  });
});

function eventFixture(overrides: Partial<RawEvent> = {}): RawEvent {
  return {
    idempotencyKey: createRawEventIdempotencyKey({
      provider: "feishu",
      eventId: "event-1",
    }),
    provider: "feishu",
    eventType: "im.message.receive_v1",
    rawBody: { event_id: "event-1" },
    receivedAt: new Date("2026-07-02T01:00:00.000Z"),
    attempts: 0,
    ...overrides,
  };
}
```

- [ ] **Step 6: Implement Redis queue**

Create `apps/core/src/events/redis-raw-event-queue.ts` by mirroring the reindex queue pattern:

```ts
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
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<number | string>;
  rPush(key: string, value: string): Promise<number>;
  lPop(key: string): Promise<string | null>;
  lLen(key: string): Promise<number>;
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
      await client.eval(ENQUEUE_SCRIPT, {
        keys: [seenKey, queueKey],
        arguments: [event.idempotencyKey, serializeRawEvent(event)],
      });
    },
    async dequeueBatch(limit) {
      const safeLimit = Math.max(0, Math.floor(limit));
      const events: RawEvent[] = [];
      for (let index = 0; index < safeLimit; index += 1) {
        const payload = await client.lPop(queueKey);
        if (payload === null) {
          break;
        }
        events.push(parseRawEvent(payload));
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
      await client.rPush(queueKey, serializeRawEvent(failedEvent));
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
```

Add parser helpers equivalent to `parseDocumentReindexJob`, validating provider, event type, idempotency key, receivedAt, and attempts.

- [ ] **Step 7: Run queue tests and typecheck**

Run:

```powershell
npm --workspace apps/core test -- raw-event-queue.test.ts redis-raw-event-queue.test.ts
npm run typecheck
```

Expected: queue tests PASS and typecheck PASS.

- [ ] **Step 8: Commit**

Run:

```powershell
git add apps/core/src/events apps/core/tests/raw-event-queue.test.ts apps/core/tests/redis-raw-event-queue.test.ts
git commit -m "feat: add raw event queue implementations"
```

## Task 2: Feishu Gateway Raw Event Enqueue

**Files:**
- Modify: `apps/core/src/feishu/feishu-gateway.ts`
- Modify: `apps/core/src/app.ts`
- Test: `apps/core/tests/feishu-gateway.test.ts`
- Test: `apps/core/tests/answer-draft-api.test.ts` if app dependency shape changes

- [ ] **Step 1: Write failing Gateway tests**

Update `apps/core/tests/feishu-gateway.test.ts` to pass a fake raw event queue and assert callback enqueue:

```ts
it("enqueues raw Feishu events for async processing", async () => {
  const rawEventQueue = { enqueue: vi.fn(async () => undefined) };
  const gateway = createFeishuGateway({
    queue: new InMemoryEventQueue(),
    rawEventQueue,
    now: () => new Date("2026-07-02T01:00:00.000Z"),
  });
  const body = {
    header: {
      event_id: "event-1",
      event_type: "im.message.receive_v1",
    },
    event: {
      message: {
        message_id: "message-1",
        chat_id: "chat-1",
        message_type: "text",
        content: "{\"text\":\"hello\"}",
      },
    },
  };

  await gateway.handleCallback({ headers: {}, body });

  expect(rawEventQueue.enqueue).toHaveBeenCalledWith({
    idempotencyKey: "raw-event:feishu:event-1",
    provider: "feishu",
    eventType: "im.message.receive_v1",
    rawBody: body,
    receivedAt: new Date("2026-07-02T01:00:00.000Z"),
    attempts: 0,
  });
});
```

- [ ] **Step 2: Run Gateway tests to verify they fail**

Run:

```powershell
npm --workspace apps/core test -- feishu-gateway.test.ts
```

Expected: FAIL because `rawEventQueue` and `now` dependencies do not exist.

- [ ] **Step 3: Extend Gateway dependencies**

In `apps/core/src/feishu/feishu-gateway.ts`, add:

```ts
import {
  createRawEventIdempotencyKey,
  type RawEventQueue,
} from "../events/raw-event-queue.js";
```

Extend dependencies:

```ts
rawEventQueue?: Pick<RawEventQueue, "enqueue">;
now?: () => Date;
```

Default `now = () => new Date()`.

- [ ] **Step 4: Enqueue raw event after validation/challenge handling**

After request verification and before existing normalized event queue enqueue, compute:

```ts
const eventId = readFeishuEventId(body);
const eventType = readFeishuEventType(body);
if (rawEventQueue !== undefined && eventId.length > 0) {
  await rawEventQueue.enqueue({
    idempotencyKey: createRawEventIdempotencyKey({ provider: "feishu", eventId }),
    provider: "feishu",
    eventType,
    rawBody: body,
    receivedAt: now(),
    attempts: 0,
  });
}
```

Add helpers that read `body.header.event_id`, `body.event.event_id`, or fallback to an existing message id if event id is absent. If no stable id can be found, use a deterministic hash of the raw body for v1.

- [ ] **Step 5: Wire app dependency**

Modify `BuildAppDependencies` in `apps/core/src/app.ts` to include:

```ts
rawEventQueue?: Pick<RawEventQueue, "enqueue">;
```

Pass it into `createFeishuGateway`.

- [ ] **Step 6: Run Gateway tests and typecheck**

Run:

```powershell
npm --workspace apps/core test -- feishu-gateway.test.ts
npm run typecheck
```

Expected: tests PASS and typecheck PASS.

- [ ] **Step 7: Commit**

Run:

```powershell
git add apps/core/src/feishu/feishu-gateway.ts apps/core/src/app.ts apps/core/tests/feishu-gateway.test.ts
git commit -m "feat: enqueue raw Feishu events"
```

## Task 3: Raw Event Worker, Loop, Runtime, And Status API

**Files:**
- Create: `apps/core/src/events/raw-event-worker.ts`
- Create: `apps/core/src/events/raw-event-worker-loop.ts`
- Create: `apps/core/src/runtime/event-worker-runtime.ts`
- Modify: `apps/core/src/config/env.ts`
- Modify: `apps/core/src/app.ts`
- Test: `apps/core/tests/raw-event-worker.test.ts`
- Test: `apps/core/tests/raw-event-worker-loop.test.ts`
- Test: `apps/core/tests/event-worker-runtime.test.ts`
- Test: `apps/core/tests/answer-draft-api.test.ts`
- Test: `apps/core/tests/env.test.ts`

- [ ] **Step 1: Write worker and loop tests**

Create tests mirroring reindex worker and loop:

```ts
// apps/core/tests/raw-event-worker.test.ts
import { describe, expect, it, vi } from "vitest";
import type { RawEvent } from "../src/events/raw-event-queue.js";
import { createRawEventWorker } from "../src/events/raw-event-worker.js";

describe("RawEventWorker", () => {
  it("processes raw events", async () => {
    const event = eventFixture();
    const worker = createRawEventWorker({
      queue: { dequeueBatch: vi.fn(async () => [event]), handleFailedEvent: vi.fn() },
      processor: { process: vi.fn(async () => undefined) },
    });

    await expect(worker.processBatch({ limit: 10 })).resolves.toEqual([
      { status: "processed", idempotencyKey: event.idempotencyKey, eventType: event.eventType },
    ]);
  });

  it("requeues failed events and continues processing", async () => {
    const first = eventFixture({ idempotencyKey: "raw-event:feishu:event-1" });
    const second = eventFixture({ idempotencyKey: "raw-event:feishu:event-2" });
    const queue = {
      dequeueBatch: vi.fn(async () => [first, second]),
      handleFailedEvent: vi.fn(async () => ({ action: "requeued" as const, attempts: 1 })),
    };
    const processor = {
      process: vi.fn().mockRejectedValueOnce(new Error("processor failed")).mockResolvedValueOnce(undefined),
    };
    const worker = createRawEventWorker({ queue, processor });

    await expect(worker.processBatch({ limit: 10 })).resolves.toEqual([
      {
        status: "failed",
        idempotencyKey: "raw-event:feishu:event-1",
        eventType: "im.message.receive_v1",
        errorMessage: "processor failed",
        retryAction: "requeued",
        attempts: 1,
      },
      {
        status: "processed",
        idempotencyKey: "raw-event:feishu:event-2",
        eventType: "im.message.receive_v1",
      },
    ]);
  });
});
```

Create `raw-event-worker-loop.test.ts` with the same structure as `document-reindex-worker-loop.test.ts`, asserting `processedCount` and `failedCount`.

- [ ] **Step 2: Implement worker and loop**

Create `apps/core/src/events/raw-event-worker.ts` and `apps/core/src/events/raw-event-worker-loop.ts` by adapting the reindex worker/loop patterns, replacing indexed/skipped counts with processed/failed counts.

- [ ] **Step 3: Add env config tests**

In `apps/core/tests/env.test.ts`, add tests for:

```ts
readEventWorkerRuntimeConfig({})
readEventWorkerRuntimeConfig({
  IRIS_EVENT_WORKER_ENABLED: "true",
  REDIS_URL: "redis://localhost:6379",
  IRIS_EVENT_WORKER_INTERVAL_MS: "2000",
  IRIS_EVENT_WORKER_BATCH_LIMIT: "25",
})
```

Expected enabled false by default, and enabled true with sanitized interval/batch limit.

- [ ] **Step 4: Implement env config**

In `apps/core/src/config/env.ts`, add:

```ts
export type EventWorkerRuntimeConfig =
  | { enabled: false }
  | { enabled: true; redisUrl: string; intervalMs: number; batchLimit: number };

export function readEventWorkerRuntimeConfig(env: EnvLike): EventWorkerRuntimeConfig {
  if (env.IRIS_EVENT_WORKER_ENABLED !== "true") {
    return { enabled: false };
  }

  return {
    enabled: true,
    redisUrl: readRequiredString(env.REDIS_URL, "REDIS_URL"),
    intervalMs: readPositiveInteger(env.IRIS_EVENT_WORKER_INTERVAL_MS, 1000),
    batchLimit: readPositiveInteger(env.IRIS_EVENT_WORKER_BATCH_LIMIT, 50),
  };
}
```

- [ ] **Step 5: Implement runtime composer**

Create `apps/core/src/runtime/event-worker-runtime.ts`:

```ts
export type EventWorkerRuntime = {
  getStatus(): Promise<EventWorkerRuntimeStatus>;
  start(): void;
  close(): Promise<void>;
};
```

Compose Redis queue, no-op processor, worker, loop, and expose status with pending/DLQ counts.

- [ ] **Step 6: Add app status route**

In `apps/core/src/app.ts`, compose event runtime:

```ts
const eventWorkerRuntime = (dependencies.createEventWorkerRuntime ?? createEventWorkerRuntime)();
eventWorkerRuntime?.start();
```

Add:

```ts
app.get("/internal/events/status", async (_request, reply) => {
  if (eventWorkerRuntime === undefined) {
    return { ok: true, enabled: false, running: false };
  }

  try {
    return { ok: true, ...(await eventWorkerRuntime.getStatus()) };
  } catch {
    return reply.code(500).send({ ok: false, error: "event_worker_status_failed" });
  }
});
```

Close runtime in `onClose`.

- [ ] **Step 7: Run tests and typecheck**

Run:

```powershell
npm --workspace apps/core test -- raw-event-worker.test.ts raw-event-worker-loop.test.ts event-worker-runtime.test.ts answer-draft-api.test.ts env.test.ts
npm run typecheck
```

Expected: tests PASS and typecheck PASS.

- [ ] **Step 8: Commit**

Run:

```powershell
git add apps/core/src/events apps/core/src/runtime/event-worker-runtime.ts apps/core/src/config/env.ts apps/core/src/app.ts apps/core/tests
git commit -m "feat: add raw event worker runtime"
```

## Task 4: Final Verification And PR Update

**Files:**
- Modify PR #3 body through `gh pr edit`.

- [ ] **Step 1: Run full verification**

Run:

```powershell
npm run typecheck
npm test
```

Run:

```powershell
python -m pytest
```

from `D:\work\AGE-org\workers\ai`.

Run:

```powershell
docker compose config
```

from `D:\work\AGE-org`.

Expected all commands exit 0.

- [ ] **Step 2: Push branch**

Run:

```powershell
git status --short --branch
git push origin codex/iris-document-source-registry
```

- [ ] **Step 3: Update PR body**

Append:

```markdown
- Add Phase 2T Feishu raw event queue foundation: Redis-backed raw event ingestion, retry/DLQ semantics, worker runtime, and internal event status.
```

- [ ] **Step 4: Verify PR status**

Run:

```powershell
gh pr view 3 --repo xfbbert-dotcom/iris --json number,state,isDraft,mergeable,headRefOid,url,body
```

Expected PR is open, mergeable or not explicitly blocked, and body includes Phase 2T.
