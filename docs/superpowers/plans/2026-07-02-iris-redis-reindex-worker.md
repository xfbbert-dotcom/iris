# Iris Redis Reindex Worker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Phase 2O of Iris: add a Redis-backed document reindex queue and an automatic polling worker loop.

**Architecture:** Keep the existing `DocumentReindexQueue` and `DocumentReindexWorker` contracts stable. Add a Redis queue implementation with atomic Lua enqueue semantics, a small worker-loop scheduler around `processBatch`, and environment config for opt-in runtime wiring.

**Tech Stack:** TypeScript, Vitest, Redis npm client, existing Iris reindex worker, existing config/env patterns.

---

## Scope

This plan implements the approved Phase 2O design in `docs/superpowers/specs/2026-07-02-iris-redis-reindex-worker-design.md`.

It includes:

- `redis` package dependency in `apps/core`;
- `RedisDocumentReindexQueue`;
- JSON serialization and validation for reindex jobs;
- atomic Redis enqueue through Lua `EVAL`;
- FIFO batch dequeue through repeated `LPOP`;
- `DocumentReindexWorkerLoop`;
- reindex worker environment config;
- app lifecycle hook support for an injected worker runtime;
- deterministic unit tests with fake Redis clients and fake timers.

It intentionally does not implement:

- BullMQ;
- Redis Streams;
- visibility timeout;
- retry counters;
- dead-letter queues;
- worker metrics UI;
- full production semantic-indexer runtime composition.

## File Structure

Create:

```text
apps/core/src/reindex/redis-document-reindex-queue.ts
apps/core/src/reindex/document-reindex-worker-loop.ts
apps/core/tests/redis-document-reindex-queue.test.ts
apps/core/tests/document-reindex-worker-loop.test.ts
```

Modify:

```text
apps/core/package.json
package-lock.json
apps/core/src/config/env.ts
apps/core/tests/env.test.ts
apps/core/src/app.ts
apps/core/tests/answer-draft-api.test.ts
```

Responsibilities:

- Redis queue file: serialization, parsing, atomic enqueue, FIFO batch dequeue.
- Worker loop file: start/stop lifecycle and non-overlapping polling.
- Env config: opt-in worker settings.
- App wiring: optional injected runtime lifecycle, without forcing Redis in tests or default startup.

## Task 1: Add Redis Dependency

**Files:**
- Modify: `apps/core/package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: Install Redis package**

Run:

```powershell
npm install redis --workspace apps/core
```

Expected: `apps/core/package.json` includes `redis`, and `package-lock.json` updates.

- [ ] **Step 2: Verify install does not break existing checks**

Run:

```powershell
npm run typecheck
npm --workspace apps/core test -- env.test.ts
```

Expected: both commands pass.

- [ ] **Step 3: Commit dependency update**

Run:

```powershell
git add apps/core/package.json package-lock.json
git commit -m "chore: add Redis client dependency"
```

Expected: commit succeeds.

## Task 2: Add Redis Reindex Queue

**Files:**
- Create: `apps/core/src/reindex/redis-document-reindex-queue.ts`
- Create: `apps/core/tests/redis-document-reindex-queue.test.ts`

- [ ] **Step 1: Write failing Redis queue tests**

Create `apps/core/tests/redis-document-reindex-queue.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";

import {
  createDocumentReindexIdempotencyKey,
  type DocumentReindexJob,
} from "../src/reindex/document-reindex-queue.js";
import {
  createRedisDocumentReindexQueue,
  parseDocumentReindexJob,
  serializeDocumentReindexJob,
  type RedisDocumentReindexQueueClient,
} from "../src/reindex/redis-document-reindex-queue.js";

describe("RedisDocumentReindexQueue", () => {
  it("atomically enqueues jobs through Redis eval", async () => {
    const client: RedisDocumentReindexQueueClient = {
      eval: vi.fn(async () => 1),
      lPop: vi.fn(),
    };
    const queue = createRedisDocumentReindexQueue({ client });
    const job = jobFixture();

    await queue.enqueue(job);

    expect(client.eval).toHaveBeenCalledWith(expect.stringContaining("SADD"), {
      keys: ["iris:reindex:documents:seen", "iris:reindex:documents:queue"],
      arguments: [job.idempotencyKey, serializeDocumentReindexJob(job)],
    });
  });

  it("dequeues jobs in FIFO order up to limit", async () => {
    const first = jobFixture({ documentSnapshotId: "snapshot-1" });
    const second = jobFixture({ documentSnapshotId: "snapshot-2" });
    const client: RedisDocumentReindexQueueClient = {
      eval: vi.fn(),
      lPop: vi
        .fn()
        .mockResolvedValueOnce(serializeDocumentReindexJob(first))
        .mockResolvedValueOnce(serializeDocumentReindexJob(second))
        .mockResolvedValueOnce(null),
    };
    const queue = createRedisDocumentReindexQueue({ client });

    await expect(queue.dequeueBatch(10)).resolves.toEqual([first, second]);
    expect(client.lPop).toHaveBeenCalledTimes(3);
  });

  it("respects dequeue batch limits", async () => {
    const first = jobFixture({ documentSnapshotId: "snapshot-1" });
    const second = jobFixture({ documentSnapshotId: "snapshot-2" });
    const client: RedisDocumentReindexQueueClient = {
      eval: vi.fn(),
      lPop: vi
        .fn()
        .mockResolvedValueOnce(serializeDocumentReindexJob(first))
        .mockResolvedValueOnce(serializeDocumentReindexJob(second)),
    };
    const queue = createRedisDocumentReindexQueue({ client });

    await expect(queue.dequeueBatch(1)).resolves.toEqual([first]);
    expect(client.lPop).toHaveBeenCalledTimes(1);
  });

  it("round-trips job dates through JSON", () => {
    const job = jobFixture();

    expect(parseDocumentReindexJob(serializeDocumentReindexJob(job))).toEqual(job);
  });

  it("rejects malformed queue payloads", () => {
    expect(() => parseDocumentReindexJob("{")).toThrow("Invalid document reindex job JSON");
    expect(() => parseDocumentReindexJob(JSON.stringify({ idempotencyKey: "x" }))).toThrow(
      "Invalid document reindex job payload",
    );
    expect(() =>
      parseDocumentReindexJob(
        JSON.stringify({
          ...jobFixture(),
          reason: "unknown",
          enqueuedAt: "2026-07-02T01:00:00.000Z",
        }),
      ),
    ).toThrow("Invalid document reindex job payload");
  });
});

function jobFixture(overrides: Partial<DocumentReindexJob> = {}): DocumentReindexJob {
  const embeddingProfileId = overrides.embeddingProfileId ?? "profile-1536";
  const documentSnapshotId = overrides.documentSnapshotId ?? "snapshot-1";

  return {
    idempotencyKey: createDocumentReindexIdempotencyKey({
      embeddingProfileId,
      documentSnapshotId,
    }),
    embeddingProfileId,
    documentSnapshotId,
    reason: "manual_profile_reindex",
    enqueuedAt: new Date("2026-07-02T01:00:00.000Z"),
    ...overrides,
  };
}
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```powershell
npm --workspace apps/core test -- redis-document-reindex-queue.test.ts
```

Expected: FAIL because `redis-document-reindex-queue.ts` does not exist.

- [ ] **Step 3: Implement Redis queue**

Create `apps/core/src/reindex/redis-document-reindex-queue.ts`:

```ts
import type { DocumentReindexJob, DocumentReindexQueue } from "./document-reindex-queue.js";

const DEFAULT_SEEN_KEY = "iris:reindex:documents:seen";
const DEFAULT_QUEUE_KEY = "iris:reindex:documents:queue";

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
  lPop(key: string): Promise<string | null>;
};

export type RedisDocumentReindexQueueOptions = {
  client: RedisDocumentReindexQueueClient;
  seenKey?: string;
  queueKey?: string;
};

export function createRedisDocumentReindexQueue({
  client,
  seenKey = DEFAULT_SEEN_KEY,
  queueKey = DEFAULT_QUEUE_KEY,
}: RedisDocumentReindexQueueOptions): DocumentReindexQueue {
  return {
    async enqueue(job) {
      await client.eval(ENQUEUE_SCRIPT, {
        keys: [seenKey, queueKey],
        arguments: [job.idempotencyKey, serializeDocumentReindexJob(job)],
      });
    },

    async dequeueBatch(limit) {
      const safeLimit = Math.max(0, Math.floor(limit));
      const jobs: DocumentReindexJob[] = [];

      for (let index = 0; index < safeLimit; index += 1) {
        const payload = await client.lPop(queueKey);
        if (payload === null) {
          break;
        }

        jobs.push(parseDocumentReindexJob(payload));
      }

      return jobs;
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
  if (
    !isValidReason(reason) ||
    Number.isNaN(enqueuedAt.getTime()) ||
    readString(parsed.idempotencyKey).length === 0 ||
    readString(parsed.embeddingProfileId).length === 0 ||
    readString(parsed.documentSnapshotId).length === 0
  ) {
    throw new Error("Invalid document reindex job payload");
  }

  return {
    idempotencyKey: readString(parsed.idempotencyKey),
    embeddingProfileId: readString(parsed.embeddingProfileId),
    documentSnapshotId: readString(parsed.documentSnapshotId),
    reason,
    enqueuedAt,
  };
}

function readString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isValidReason(value: unknown): value is DocumentReindexJob["reason"] {
  return value === "document_synced" || value === "manual_profile_reindex";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
```

- [ ] **Step 4: Run Redis queue tests and typecheck**

Run:

```powershell
npm --workspace apps/core test -- redis-document-reindex-queue.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit Redis queue**

Run:

```powershell
git add apps/core/src/reindex/redis-document-reindex-queue.ts apps/core/tests/redis-document-reindex-queue.test.ts
git commit -m "feat: add Redis document reindex queue"
```

Expected: commit succeeds.

## Task 3: Add Worker Polling Loop

**Files:**
- Create: `apps/core/src/reindex/document-reindex-worker-loop.ts`
- Create: `apps/core/tests/document-reindex-worker-loop.test.ts`

- [ ] **Step 1: Write failing worker loop tests**

Create `apps/core/tests/document-reindex-worker-loop.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";

import { createDocumentReindexWorkerLoop } from "../src/reindex/document-reindex-worker-loop.js";

describe("DocumentReindexWorkerLoop", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("polls the worker after start", async () => {
    vi.useFakeTimers();
    const worker = { processBatch: vi.fn(async () => []) };
    const loop = createDocumentReindexWorkerLoop({
      worker,
      intervalMs: 1000,
      batchLimit: 25,
    });

    loop.start();
    await vi.runOnlyPendingTimersAsync();

    expect(worker.processBatch).toHaveBeenCalledWith({ limit: 25 });
    await loop.stop();
  });

  it("does not create duplicate loops on repeated start", async () => {
    vi.useFakeTimers();
    const worker = { processBatch: vi.fn(async () => []) };
    const loop = createDocumentReindexWorkerLoop({
      worker,
      intervalMs: 1000,
      batchLimit: 25,
    });

    loop.start();
    loop.start();
    await vi.runOnlyPendingTimersAsync();

    expect(worker.processBatch).toHaveBeenCalledTimes(1);
    await loop.stop();
  });

  it("stops future ticks", async () => {
    vi.useFakeTimers();
    const worker = { processBatch: vi.fn(async () => []) };
    const loop = createDocumentReindexWorkerLoop({
      worker,
      intervalMs: 1000,
      batchLimit: 25,
    });

    loop.start();
    await loop.stop();
    await vi.runOnlyPendingTimersAsync();

    expect(worker.processBatch).not.toHaveBeenCalled();
  });

  it("reports errors and continues polling", async () => {
    vi.useFakeTimers();
    const error = new Error("batch failed");
    const worker = {
      processBatch: vi.fn().mockRejectedValueOnce(error).mockResolvedValueOnce([]),
    };
    const onError = vi.fn();
    const loop = createDocumentReindexWorkerLoop({
      worker,
      intervalMs: 1000,
      batchLimit: 25,
      onError,
    });

    loop.start();
    await vi.runOnlyPendingTimersAsync();
    await vi.advanceTimersByTimeAsync(1000);

    expect(onError).toHaveBeenCalledWith(error);
    expect(worker.processBatch).toHaveBeenCalledTimes(2);
    await loop.stop();
  });

  it("does not overlap long-running batches", async () => {
    vi.useFakeTimers();
    let resolveBatch: (() => void) | undefined;
    const worker = {
      processBatch: vi.fn(
        () =>
          new Promise<[]>((resolve) => {
            resolveBatch = () => resolve([]);
          }),
      ),
    };
    const loop = createDocumentReindexWorkerLoop({
      worker,
      intervalMs: 1000,
      batchLimit: 25,
    });

    loop.start();
    await vi.runOnlyPendingTimersAsync();
    await vi.advanceTimersByTimeAsync(5000);

    expect(worker.processBatch).toHaveBeenCalledTimes(1);
    resolveBatch?.();
    await vi.runOnlyPendingTimersAsync();

    expect(worker.processBatch).toHaveBeenCalledTimes(2);
    await loop.stop();
  });
});
```

- [ ] **Step 2: Run worker loop tests to verify failure**

Run:

```powershell
npm --workspace apps/core test -- document-reindex-worker-loop.test.ts
```

Expected: FAIL because `document-reindex-worker-loop.ts` does not exist.

- [ ] **Step 3: Implement worker loop**

Create `apps/core/src/reindex/document-reindex-worker-loop.ts`:

```ts
import type { DocumentReindexJobResult } from "./document-reindex-worker.js";

type TimerHandle = ReturnType<typeof setTimeout>;

export type DocumentReindexWorkerLoopDependencies = {
  worker: {
    processBatch(input: { limit: number }): Promise<DocumentReindexJobResult[]>;
  };
  intervalMs: number;
  batchLimit: number;
  onError?: (error: unknown) => void;
  setTimeout?: typeof globalThis.setTimeout;
  clearTimeout?: typeof globalThis.clearTimeout;
};

export type DocumentReindexWorkerLoop = {
  start(): void;
  stop(): Promise<void>;
  isRunning(): boolean;
};

export function createDocumentReindexWorkerLoop({
  worker,
  intervalMs,
  batchLimit,
  onError,
  setTimeout: scheduleTimeout = globalThis.setTimeout,
  clearTimeout: cancelTimeout = globalThis.clearTimeout,
}: DocumentReindexWorkerLoopDependencies): DocumentReindexWorkerLoop {
  const safeIntervalMs = sanitizePositiveInteger("intervalMs", intervalMs);
  const safeBatchLimit = sanitizePositiveInteger("batchLimit", batchLimit);
  let running = false;
  let timer: TimerHandle | undefined;
  let inFlight: Promise<void> | undefined;

  const scheduleNext = () => {
    if (!running) {
      return;
    }
    timer = scheduleTimeout(() => {
      timer = undefined;
      inFlight = tick().finally(() => {
        inFlight = undefined;
        scheduleNext();
      });
    }, safeIntervalMs);
  };

  const tick = async () => {
    try {
      await worker.processBatch({ limit: safeBatchLimit });
    } catch (error) {
      onError?.(error);
    }
  };

  return {
    start() {
      if (running) {
        return;
      }
      running = true;
      scheduleNext();
    },

    async stop() {
      running = false;
      if (timer !== undefined) {
        cancelTimeout(timer);
        timer = undefined;
      }
      await inFlight;
    },

    isRunning() {
      return running;
    },
  };
}

function sanitizePositiveInteger(name: string, value: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }

  return value;
}
```

- [ ] **Step 4: Run worker loop tests and typecheck**

Run:

```powershell
npm --workspace apps/core test -- document-reindex-worker-loop.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit worker loop**

Run:

```powershell
git add apps/core/src/reindex/document-reindex-worker-loop.ts apps/core/tests/document-reindex-worker-loop.test.ts
git commit -m "feat: add document reindex worker loop"
```

Expected: commit succeeds.

## Task 4: Add Reindex Worker Runtime Config

**Files:**
- Modify: `apps/core/src/config/env.ts`
- Modify: `apps/core/tests/env.test.ts`

- [ ] **Step 1: Write failing config tests**

Append to `apps/core/tests/env.test.ts` imports and tests.

Add `readReindexWorkerRuntimeConfig` to the import list:

```ts
import {
  readAnswerDraftRuntimeConfig,
  readEmbeddingProviderConfig,
  readFeishuAuthConfig,
  readModelProviderConfig,
  readReindexWorkerRuntimeConfig,
} from "../src/config/env.js";
```

Append:

```ts
describe("readReindexWorkerRuntimeConfig", () => {
  it("returns disabled config by default", () => {
    expect(readReindexWorkerRuntimeConfig({})).toEqual({ enabled: false });
    expect(readReindexWorkerRuntimeConfig({ IRIS_REINDEX_WORKER_ENABLED: "false" })).toEqual({
      enabled: false,
    });
  });

  it("reads enabled Redis worker config", () => {
    expect(
      readReindexWorkerRuntimeConfig({
        IRIS_REINDEX_WORKER_ENABLED: " true ",
        REDIS_URL: " redis://localhost:6379 ",
        IRIS_REINDEX_WORKER_INTERVAL_MS: " 500 ",
        IRIS_REINDEX_WORKER_BATCH_LIMIT: " 10 ",
      }),
    ).toEqual({
      enabled: true,
      redisUrl: "redis://localhost:6379",
      intervalMs: 500,
      batchLimit: 10,
    });
  });

  it("defaults enabled worker interval, batch limit, and Redis URL", () => {
    expect(
      readReindexWorkerRuntimeConfig({
        IRIS_REINDEX_WORKER_ENABLED: "true",
      }),
    ).toEqual({
      enabled: true,
      redisUrl: "redis://localhost:6379",
      intervalMs: 1000,
      batchLimit: 25,
    });
  });

  it("rejects invalid interval and batch limit values", () => {
    expect(() =>
      readReindexWorkerRuntimeConfig({
        IRIS_REINDEX_WORKER_ENABLED: "true",
        IRIS_REINDEX_WORKER_INTERVAL_MS: "0",
      }),
    ).toThrow("IRIS_REINDEX_WORKER_INTERVAL_MS must be a positive integer");

    expect(() =>
      readReindexWorkerRuntimeConfig({
        IRIS_REINDEX_WORKER_ENABLED: "true",
        IRIS_REINDEX_WORKER_BATCH_LIMIT: "-1",
      }),
    ).toThrow("IRIS_REINDEX_WORKER_BATCH_LIMIT must be a positive integer");
  });
});
```

- [ ] **Step 2: Run config tests to verify failure**

Run:

```powershell
npm --workspace apps/core test -- env.test.ts
```

Expected: FAIL because `readReindexWorkerRuntimeConfig` is not exported.

- [ ] **Step 3: Implement config reader**

Modify `apps/core/src/config/env.ts`.

Add type:

```ts
export type ReindexWorkerRuntimeConfig =
  | { enabled: false }
  | {
      enabled: true;
      redisUrl: string;
      intervalMs: number;
      batchLimit: number;
    };
```

Add function:

```ts
export function readReindexWorkerRuntimeConfig(
  env: EnvLike = process.env,
): ReindexWorkerRuntimeConfig {
  const enabled = readOptionalEnv(env.IRIS_REINDEX_WORKER_ENABLED);
  if (enabled !== "true") {
    return { enabled: false };
  }

  return {
    enabled: true,
    redisUrl: readOptionalEnv(env.REDIS_URL) ?? "redis://localhost:6379",
    intervalMs: readPositiveIntegerEnv(
      "IRIS_REINDEX_WORKER_INTERVAL_MS",
      env.IRIS_REINDEX_WORKER_INTERVAL_MS,
      1000,
    ),
    batchLimit: readPositiveIntegerEnv(
      "IRIS_REINDEX_WORKER_BATCH_LIMIT",
      env.IRIS_REINDEX_WORKER_BATCH_LIMIT,
      25,
    ),
  };
}
```

- [ ] **Step 4: Run config tests and typecheck**

Run:

```powershell
npm --workspace apps/core test -- env.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit config**

Run:

```powershell
git add apps/core/src/config/env.ts apps/core/tests/env.test.ts
git commit -m "feat: add reindex worker runtime config"
```

Expected: commit succeeds.

## Task 5: Add App Lifecycle Hook for Reindex Runtime

**Files:**
- Modify: `apps/core/src/app.ts`
- Modify: `apps/core/tests/answer-draft-api.test.ts`

- [ ] **Step 1: Write failing app lifecycle test**

Append to `apps/core/tests/answer-draft-api.test.ts`:

```ts
  it("starts and closes an injected reindex worker runtime", async () => {
    const reindexWorkerRuntime = {
      start: vi.fn(),
      close: vi.fn(async () => undefined),
    };
    const app = buildApp({
      createAnswerDraftRuntime: () => undefined,
      createReindexWorkerRuntime: () => reindexWorkerRuntime,
    });

    expect(reindexWorkerRuntime.start).toHaveBeenCalledOnce();
    await app.close();
    expect(reindexWorkerRuntime.close).toHaveBeenCalledOnce();
  });
```

Place this test inside the existing `describe("answer draft runtime wiring", () => {` block, before that block's closing `});`.

- [ ] **Step 2: Run app test to verify failure**

Run:

```powershell
npm --workspace apps/core test -- answer-draft-api.test.ts
```

Expected: FAIL because `createReindexWorkerRuntime` is not in `BuildAppDependencies`.

- [ ] **Step 3: Implement optional app runtime lifecycle**

Modify `apps/core/src/app.ts`.

Add type:

```ts
export type ReindexWorkerRuntime = {
  start(): void;
  close(): Promise<void>;
};
```

Add to `BuildAppDependencies`:

```ts
createReindexWorkerRuntime?: () => ReindexWorkerRuntime | undefined;
```

In `buildApp`, after answer draft runtime composition:

```ts
  const reindexWorkerRuntime = dependencies.createReindexWorkerRuntime?.();
  reindexWorkerRuntime?.start();
```

In `onClose`:

```ts
    await reindexWorkerRuntime?.close();
```

Keep this as an injected lifecycle hook only. Do not compose Redis in `app.ts` in this task.

- [ ] **Step 4: Run app test and typecheck**

Run:

```powershell
npm --workspace apps/core test -- answer-draft-api.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit app lifecycle hook**

Run:

```powershell
git add apps/core/src/app.ts apps/core/tests/answer-draft-api.test.ts
git commit -m "feat: add reindex worker app lifecycle hook"
```

Expected: commit succeeds.

## Task 6: Final Verification and PR Update

**Files:**
- Modify PR body only.

- [ ] **Step 1: Run TypeScript typecheck**

Run:

```powershell
npm run typecheck
```

Expected: PASS.

- [ ] **Step 2: Run all TypeScript tests**

Run:

```powershell
npm test
```

Expected: PASS.

- [ ] **Step 3: Run Python worker tests**

Run from `workers/ai`:

```powershell
python -m pytest
```

Expected: PASS.

- [ ] **Step 4: Validate Docker Compose**

Run:

```powershell
docker compose config
```

Expected: resolved compose config prints successfully.

- [ ] **Step 5: Push branch and update PR**

Run:

```powershell
git push origin codex/iris-document-source-registry
$body = gh pr view 3 --repo xfbbert-dotcom/iris --json body --jq .body
$phase2O = "- Add Phase 2O Redis reindex worker foundation: Redis-backed queue with atomic enqueue, automatic worker polling loop, runtime config, and app lifecycle hook."
if ($body -notlike "*Phase 2O Redis reindex worker foundation*") {
  $body = $body -replace "(## Test Plan)", "$phase2O`n`n`$1"
}
$body | gh pr edit 3 --repo xfbbert-dotcom/iris --body-file -
gh pr view 3 --repo xfbbert-dotcom/iris --json number,state,isDraft,mergeable,headRefOid,url
```

Expected: push succeeds and PR remains open and mergeable.

## Self-Review Checklist

- Redis enqueue uses one Lua `EVAL` operation for dedupe plus push.
- Redis queue preserves the existing `DocumentReindexQueue` contract.
- Redis queue tests do not require a real Redis server.
- Worker loop does not run overlapping batches.
- Worker loop survives batch errors and reports them.
- Reindex worker runtime is disabled by default.
- App startup still works without Redis by default.
- Feishu callback acknowledgement path remains unrelated to reindex processing.
