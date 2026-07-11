# Iris Reindex DLQ Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add internal APIs for listing, replaying, batch replaying, and deleting reindex dead-letter jobs.

**Architecture:** Extend the existing reindex queue boundary with DLQ management operations, then expose those operations through `ReindexWorkerRuntime` and internal Fastify routes. Keep Redis behavior simple and bounded: list via `LRANGE`, mutate by matching stored payload IDs, replay by pushing the reset job directly to the main queue.

**Tech Stack:** TypeScript, Fastify app injection tests, Vitest, Redis list operations, existing Iris reindex queue/runtime modules.

---

## File Structure

- Modify `apps/core/src/reindex/document-reindex-queue.ts`: add `DocumentReindexDeadLetter` type and DLQ management methods to the queue interface.
- Modify `apps/core/src/reindex/in-memory-document-reindex-queue.ts`: store dead letters with IDs and implement list/replay/delete/batch replay.
- Modify `apps/core/src/reindex/redis-document-reindex-queue.ts`: serialize new DLQ payload IDs, parse legacy payloads, implement `lRange`/`lRem` based management.
- Modify `apps/core/src/runtime/reindex-worker-runtime.ts`: expose `deadLetters` runtime boundary and add Redis client adapter methods.
- Modify `apps/core/src/app.ts`: add internal DLQ management routes.
- Modify tests:
  - `apps/core/tests/document-reindex-queue.test.ts`
  - `apps/core/tests/redis-document-reindex-queue.test.ts`
  - `apps/core/tests/reindex-worker-runtime.test.ts`
  - `apps/core/tests/answer-draft-api.test.ts`

## Task 1: Queue Contract And In-Memory DLQ Management

**Files:**
- Modify: `apps/core/src/reindex/document-reindex-queue.ts`
- Modify: `apps/core/src/reindex/in-memory-document-reindex-queue.ts`
- Test: `apps/core/tests/document-reindex-queue.test.ts`

- [ ] **Step 1: Write failing in-memory queue tests**

Add tests to `apps/core/tests/document-reindex-queue.test.ts`:

```ts
  it("lists dead-lettered jobs with generated ids", async () => {
    const queue = new InMemoryDocumentReindexQueue({
      maxAttempts: 1,
      idGenerator: () => "dlq-1",
      now: () => new Date("2026-07-02T01:05:00.000Z"),
    });
    const job = jobFixture();

    await queue.handleFailedJob({ job, errorMessage: "embedding failed" });

    await expect(queue.listDeadLetters({ limit: 20 })).resolves.toEqual([
      {
        id: "dlq-1",
        job: { ...job, attempts: 1 },
        errorMessage: "embedding failed",
        failedAt: new Date("2026-07-02T01:05:00.000Z"),
        replayable: true,
      },
    ]);
  });

  it("replays dead-lettered jobs with attempts reset", async () => {
    const queue = new InMemoryDocumentReindexQueue({
      maxAttempts: 1,
      idGenerator: () => "dlq-1",
      now: () => new Date("2026-07-02T01:05:00.000Z"),
    });
    const job = jobFixture({ attempts: 0 });
    await queue.handleFailedJob({ job, errorMessage: "embedding failed" });

    await expect(queue.replayDeadLetter("dlq-1")).resolves.toBe("replayed");
    await expect(queue.listDeadLetters({ limit: 20 })).resolves.toEqual([]);
    await expect(queue.dequeueBatch(1)).resolves.toEqual([{ ...job, attempts: 0 }]);
  });

  it("deletes dead-lettered jobs without replaying them", async () => {
    const queue = new InMemoryDocumentReindexQueue({
      maxAttempts: 1,
      idGenerator: () => "dlq-1",
      now: () => new Date("2026-07-02T01:05:00.000Z"),
    });
    await queue.handleFailedJob({ job: jobFixture(), errorMessage: "embedding failed" });

    await expect(queue.deleteDeadLetter("dlq-1")).resolves.toBe("deleted");
    await expect(queue.listDeadLetters({ limit: 20 })).resolves.toEqual([]);
    await expect(queue.dequeueBatch(1)).resolves.toEqual([]);
  });

  it("batch replays dead-lettered jobs", async () => {
    let nextId = 1;
    const queue = new InMemoryDocumentReindexQueue({
      maxAttempts: 1,
      idGenerator: () => `dlq-${nextId++}`,
    });
    await queue.handleFailedJob({ job: jobFixture({ documentSnapshotId: "snapshot-1" }), errorMessage: "first" });
    await queue.handleFailedJob({
      job: jobFixture({
        idempotencyKey: "reindex:profile-1536:snapshot-2",
        documentSnapshotId: "snapshot-2",
      }),
      errorMessage: "second",
    });

    await expect(queue.replayDeadLetters({ ids: ["dlq-1", "missing", "dlq-2"] })).resolves.toEqual({
      replayedCount: 2,
      notFoundIds: ["missing"],
      unsupportedLegacyIds: [],
    });
    await expect(queue.getDeadLetterCount()).resolves.toBe(0);
    await expect(queue.dequeueBatch(10)).resolves.toHaveLength(2);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
npm --workspace apps/core test -- document-reindex-queue.test.ts
```

Expected: FAIL because `listDeadLetters`, `replayDeadLetter`, `deleteDeadLetter`, and constructor test options do not exist.

- [ ] **Step 3: Extend queue types**

Update `apps/core/src/reindex/document-reindex-queue.ts` with:

```ts
export type DocumentReindexDeadLetter = {
  id: string;
  job: DocumentReindexJob;
  errorMessage: string;
  failedAt: Date;
  replayable: boolean;
};

export type ReplayDocumentReindexDeadLettersResult = {
  replayedCount: number;
  notFoundIds: string[];
  unsupportedLegacyIds: string[];
};
```

Add methods to `DocumentReindexQueue`:

```ts
  listDeadLetters(input: { limit: number }): Promise<DocumentReindexDeadLetter[]>;
  replayDeadLetter(id: string): Promise<"replayed" | "not_found" | "unsupported_legacy_item">;
  deleteDeadLetter(id: string): Promise<"deleted" | "not_found" | "unsupported_legacy_item">;
  replayDeadLetters(input: { ids: string[] }): Promise<ReplayDocumentReindexDeadLettersResult>;
```

- [ ] **Step 4: Implement in-memory management**

Update `apps/core/src/reindex/in-memory-document-reindex-queue.ts`:

```ts
type DeadLetteredDocumentReindexJob = {
  id: string;
  job: DocumentReindexJob;
  errorMessage: string;
  failedAt: Date;
};

export type InMemoryDocumentReindexQueueOptions = {
  maxAttempts?: number;
  idGenerator?: () => string;
  now?: () => Date;
};
```

Store `idGenerator` and `now` in the class, defaulting to:

```ts
const defaultIdGenerator = () => `dlq_${Date.now()}_${Math.random().toString(36).slice(2)}`;
```

When dead-lettering in `handleFailedJob`, push:

```ts
{
  id: this.idGenerator(),
  job: failedJob,
  errorMessage: input.errorMessage,
  failedAt: this.now(),
}
```

Add:

```ts
  async listDeadLetters(input: { limit: number }): Promise<DocumentReindexDeadLetter[]> {
    const safeLimit = Math.max(0, Math.floor(input.limit));
    return this.deadLetters.slice(0, safeLimit).map((item) => ({
      ...item,
      replayable: true,
    }));
  }

  async replayDeadLetter(id: string): Promise<"replayed" | "not_found" | "unsupported_legacy_item"> {
    const index = this.deadLetters.findIndex((item) => item.id === id);
    if (index === -1) {
      return "not_found";
    }

    const [item] = this.deadLetters.splice(index, 1);
    this.jobs.push({ ...item.job, attempts: 0 });
    return "replayed";
  }

  async deleteDeadLetter(id: string): Promise<"deleted" | "not_found" | "unsupported_legacy_item"> {
    const index = this.deadLetters.findIndex((item) => item.id === id);
    if (index === -1) {
      return "not_found";
    }

    this.deadLetters.splice(index, 1);
    return "deleted";
  }

  async replayDeadLetters(input: { ids: string[] }): Promise<ReplayDocumentReindexDeadLettersResult> {
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
  }
```

- [ ] **Step 5: Run tests and typecheck**

Run:

```powershell
npm --workspace apps/core test -- document-reindex-queue.test.ts
npm run typecheck
```

Expected: queue tests PASS; typecheck may expose Redis/runtime fake methods that later tasks will fill.

- [ ] **Step 6: Commit**

Run:

```powershell
git add apps/core/src/reindex/document-reindex-queue.ts apps/core/src/reindex/in-memory-document-reindex-queue.ts apps/core/tests/document-reindex-queue.test.ts
git commit -m "feat: add in-memory reindex DLQ management"
```

## Task 2: Redis DLQ Management

**Files:**
- Modify: `apps/core/src/reindex/redis-document-reindex-queue.ts`
- Test: `apps/core/tests/redis-document-reindex-queue.test.ts`

- [ ] **Step 1: Write failing Redis tests**

Add tests to `apps/core/tests/redis-document-reindex-queue.test.ts`:

```ts
  it("lists Redis DLQ entries", async () => {
    const deadLetter = {
      id: "dlq-1",
      job: jobFixture({ attempts: 3 }),
      errorMessage: "embedding failed",
      failedAt: "2026-07-02T01:05:00.000Z",
    };
    const client = {
      eval: vi.fn(),
      rPush: vi.fn(),
      lPop: vi.fn(),
      lLen: vi.fn(),
      lRange: vi.fn(async () => [JSON.stringify(deadLetter)]),
      lRem: vi.fn(),
    };
    const queue = createRedisDocumentReindexQueue({ client });

    await expect(queue.listDeadLetters({ limit: 20 })).resolves.toEqual([
      {
        id: "dlq-1",
        job: jobFixture({ attempts: 3 }),
        errorMessage: "embedding failed",
        failedAt: new Date("2026-07-02T01:05:00.000Z"),
        replayable: true,
      },
    ]);
    expect(client.lRange).toHaveBeenCalledWith("iris:reindex:documents:dlq", 0, 19);
  });

  it("lists legacy Redis DLQ entries as not replayable", async () => {
    const legacy = {
      job: jobFixture({ attempts: 3 }),
      errorMessage: "embedding failed",
      failedAt: "2026-07-02T01:05:00.000Z",
    };
    const client = {
      eval: vi.fn(),
      rPush: vi.fn(),
      lPop: vi.fn(),
      lLen: vi.fn(),
      lRange: vi.fn(async () => [JSON.stringify(legacy)]),
      lRem: vi.fn(),
    };
    const queue = createRedisDocumentReindexQueue({ client });

    const [item] = await queue.listDeadLetters({ limit: 20 });
    expect(item.replayable).toBe(false);
    expect(item.id).toMatch(/^legacy:/);
  });

  it("replays Redis DLQ entries with attempts reset", async () => {
    const deadLetter = {
      id: "dlq-1",
      job: jobFixture({ attempts: 3 }),
      errorMessage: "embedding failed",
      failedAt: "2026-07-02T01:05:00.000Z",
    };
    const payload = JSON.stringify(deadLetter);
    const client = {
      eval: vi.fn(),
      rPush: vi.fn(async () => 1),
      lPop: vi.fn(),
      lLen: vi.fn(),
      lRange: vi.fn(async () => [payload]),
      lRem: vi.fn(async () => 1),
    };
    const queue = createRedisDocumentReindexQueue({ client });

    await expect(queue.replayDeadLetter("dlq-1")).resolves.toBe("replayed");
    expect(client.lRem).toHaveBeenCalledWith("iris:reindex:documents:dlq", 1, payload);
    expect(client.rPush).toHaveBeenCalledWith(
      "iris:reindex:documents:queue",
      serializeDocumentReindexJob(jobFixture({ attempts: 0 })),
    );
  });

  it("deletes Redis DLQ entries", async () => {
    const deadLetter = {
      id: "dlq-1",
      job: jobFixture({ attempts: 3 }),
      errorMessage: "embedding failed",
      failedAt: "2026-07-02T01:05:00.000Z",
    };
    const payload = JSON.stringify(deadLetter);
    const client = {
      eval: vi.fn(),
      rPush: vi.fn(),
      lPop: vi.fn(),
      lLen: vi.fn(),
      lRange: vi.fn(async () => [payload]),
      lRem: vi.fn(async () => 1),
    };
    const queue = createRedisDocumentReindexQueue({ client });

    await expect(queue.deleteDeadLetter("dlq-1")).resolves.toBe("deleted");
    expect(client.lRem).toHaveBeenCalledWith("iris:reindex:documents:dlq", 1, payload);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
npm --workspace apps/core test -- redis-document-reindex-queue.test.ts
```

Expected: FAIL because Redis client lacks `lRange`/`lRem` and queue lacks management methods.

- [ ] **Step 3: Extend Redis client and options**

Update `RedisDocumentReindexQueueClient`:

```ts
  lRange(key: string, start: number, stop: number): Promise<string[]>;
  lRem(key: string, count: number, value: string): Promise<number>;
```

Add option:

```ts
  idGenerator?: () => string;
```

- [ ] **Step 4: Serialize new dead letters with IDs**

Change `serializeDeadLetteredDocumentReindexJob` to include an ID:

```ts
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
```

Call it from `handleFailedJob` with `id: idGenerator()`.

- [ ] **Step 5: Implement parsing and management**

Add helpers in `apps/core/src/reindex/redis-document-reindex-queue.ts`:

```ts
type ParsedDeadLetterPayload = {
  payload: string;
  deadLetter: DocumentReindexDeadLetter;
  storedId?: string;
};

function parseDeadLetterPayload(payload: string, index: number): ParsedDeadLetterPayload {
  const parsed = JSON.parse(payload) as Record<string, unknown>;
  const jobPayload = parsed.job;
  if (!isRecord(jobPayload)) {
    throw new Error("Invalid document reindex dead letter payload");
  }

  const job = parseDocumentReindexJob(JSON.stringify(jobPayload));
  const failedAt = new Date(readString(parsed.failedAt));
  const errorMessage = readString(parsed.errorMessage);
  const storedId = typeof parsed.id === "string" && parsed.id.length > 0 ? parsed.id : undefined;
  if (Number.isNaN(failedAt.getTime()) || errorMessage.length === 0) {
    throw new Error("Invalid document reindex dead letter payload");
  }

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
```

Implement management methods:

```ts
    async listDeadLetters(input) {
      const safeLimit = Math.max(0, Math.floor(input.limit));
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

      await client.lRem(deadLetterKey, 1, found.payload);
      await client.rPush(queueKey, serializeDocumentReindexJob({ ...found.deadLetter.job, attempts: 0 }));
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
```

Use `lRange(deadLetterKey, 0, -1)` inside `findDeadLetterByStoredId` for v1 simplicity.

- [ ] **Step 6: Run tests and typecheck**

Run:

```powershell
npm --workspace apps/core test -- redis-document-reindex-queue.test.ts
npm run typecheck
```

Expected: Redis queue tests PASS; typecheck may expose runtime fake adapter gaps for Task 3.

- [ ] **Step 7: Commit**

Run:

```powershell
git add apps/core/src/reindex/redis-document-reindex-queue.ts apps/core/tests/redis-document-reindex-queue.test.ts
git commit -m "feat: add Redis reindex DLQ management"
```

## Task 3: Runtime Boundary And Internal API Routes

**Files:**
- Modify: `apps/core/src/runtime/reindex-worker-runtime.ts`
- Modify: `apps/core/src/app.ts`
- Test: `apps/core/tests/reindex-worker-runtime.test.ts`
- Test: `apps/core/tests/answer-draft-api.test.ts`

- [ ] **Step 1: Write failing runtime and API tests**

Add to `apps/core/tests/reindex-worker-runtime.test.ts`:

```ts
    await expect(runtime?.deadLetters.list({ limit: 20 })).resolves.toEqual([]);
```

Add to `apps/core/tests/answer-draft-api.test.ts` under `GET /internal/reindex/status` or a new `describe("reindex dead-letter API")`:

```ts
  it("lists reindex dead letters", async () => {
    const runtime = fakeReindexRuntime({
      deadLetters: {
        list: vi.fn(async () => [
          {
            id: "dlq-1",
            job: {
              idempotencyKey: "reindex:profile-1536:snapshot-1",
              embeddingProfileId: "profile-1536",
              documentSnapshotId: "snapshot-1",
              reason: "manual_profile_reindex" as const,
              enqueuedAt: new Date("2026-07-02T01:00:00.000Z"),
              attempts: 3,
            },
            errorMessage: "embedding failed",
            failedAt: new Date("2026-07-02T01:05:00.000Z"),
            replayable: true,
          },
        ]),
        replay: vi.fn(),
        delete: vi.fn(),
        replayBatch: vi.fn(),
      },
    });
    const app = buildApp({
      createAnswerDraftRuntime: () => undefined,
      createReindexWorkerRuntime: () => runtime,
    });

    const response = await app.inject({
      method: "GET",
      url: "/internal/reindex/dead-letters?limit=20",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      deadLetters: [
        {
          id: "dlq-1",
          job: {
            idempotencyKey: "reindex:profile-1536:snapshot-1",
            embeddingProfileId: "profile-1536",
            documentSnapshotId: "snapshot-1",
            reason: "manual_profile_reindex",
            enqueuedAt: "2026-07-02T01:00:00.000Z",
            attempts: 3,
          },
          errorMessage: "embedding failed",
          failedAt: "2026-07-02T01:05:00.000Z",
          replayable: true,
        },
      ],
    });
    expect(runtime.deadLetters.list).toHaveBeenCalledWith({ limit: 20 });
  });

  it("replays a reindex dead letter", async () => {
    const runtime = fakeReindexRuntime({
      deadLetters: {
        list: vi.fn(),
        replay: vi.fn(async () => "replayed" as const),
        delete: vi.fn(),
        replayBatch: vi.fn(),
      },
    });
    const app = buildApp({
      createAnswerDraftRuntime: () => undefined,
      createReindexWorkerRuntime: () => runtime,
    });

    const response = await app.inject({
      method: "POST",
      url: "/internal/reindex/dead-letters/dlq-1/replay",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, status: "replayed" });
  });
```

Also add delete, batch replay, unavailable runtime, invalid request, and thrown-error route tests using the same fake runtime style.

- [ ] **Step 2: Run tests to verify they fail**

Run:

```powershell
npm --workspace apps/core test -- reindex-worker-runtime.test.ts answer-draft-api.test.ts
```

Expected: FAIL because runtime and app routes do not expose `deadLetters`.

- [ ] **Step 3: Extend runtime type and composer**

In `apps/core/src/runtime/reindex-worker-runtime.ts`, import `DocumentReindexDeadLetter` and `ReplayDocumentReindexDeadLettersResult`.

Add to `ReindexWorkerRuntime`:

```ts
  deadLetters: {
    list(input: { limit: number }): Promise<DocumentReindexDeadLetter[]>;
    replay(id: string): Promise<"replayed" | "not_found" | "unsupported_legacy_item">;
    delete(id: string): Promise<"deleted" | "not_found" | "unsupported_legacy_item">;
    replayBatch(input: { ids: string[] }): Promise<ReplayDocumentReindexDeadLettersResult>;
  };
```

Add to returned runtime:

```ts
    deadLetters: {
      list: (input) => queue.listDeadLetters(input),
      replay: (id) => queue.replayDeadLetter(id),
      delete: (id) => queue.deleteDeadLetter(id),
      replayBatch: (input) => queue.replayDeadLetters(input),
    },
```

Update Redis lazy adapter to include:

```ts
    async lRange(key, start, stop) {
      const client = await redisConnection;
      return client.lRange(key, start, stop);
    },
    async lRem(key, count, value) {
      const client = await redisConnection;
      return client.lRem(key, count, value);
    },
```

- [ ] **Step 4: Add app route helpers**

In `apps/core/src/app.ts`, add route handlers:

```ts
  app.get("/internal/reindex/dead-letters", async (request, reply) => {
    if (reindexWorkerRuntime === undefined) {
      reply.code(503);
      return { ok: false, error: "reindex_worker_unavailable" };
    }

    const limit = parseDeadLetterLimit((request.query as { limit?: unknown }).limit);
    if (limit === undefined) {
      reply.code(400);
      return { ok: false, error: "invalid_request" };
    }

    try {
      return { ok: true, deadLetters: await reindexWorkerRuntime.deadLetters.list({ limit }) };
    } catch {
      reply.code(500);
      return { ok: false, error: "reindex_dead_letter_operation_failed" };
    }
  });
```

Add equivalent POST replay, DELETE, and batch replay routes.

Add helpers:

```ts
function parseDeadLetterLimit(value: unknown): number | undefined {
  if (value === undefined) {
    return 20;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    return undefined;
  }

  return Math.min(parsed, 100);
}

function readNonBlankId(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}
```

- [ ] **Step 5: Update fakes**

Update `runtimeDependencies()` Redis fakes in `apps/core/tests/reindex-worker-runtime.test.ts` to include:

```ts
lRange: vi.fn(async () => []),
lRem: vi.fn(async () => 1),
```

Update `fakeReindexRuntime()` in `apps/core/tests/answer-draft-api.test.ts` to include:

```ts
deadLetters: {
  list: vi.fn(async () => []),
  replay: vi.fn(async () => "not_found"),
  delete: vi.fn(async () => "not_found"),
  replayBatch: vi.fn(async () => ({
    replayedCount: 0,
    notFoundIds: [],
    unsupportedLegacyIds: [],
  })),
},
```

- [ ] **Step 6: Run tests and typecheck**

Run:

```powershell
npm --workspace apps/core test -- reindex-worker-runtime.test.ts answer-draft-api.test.ts
npm run typecheck
```

Expected: tests PASS and typecheck PASS.

- [ ] **Step 7: Commit**

Run:

```powershell
git add apps/core/src/runtime/reindex-worker-runtime.ts apps/core/src/app.ts apps/core/tests/reindex-worker-runtime.test.ts apps/core/tests/answer-draft-api.test.ts
git commit -m "feat: add reindex DLQ management API"
```

## Task 4: Final Verification And PR Update

**Files:**
- Modify PR #3 body only through `gh pr edit`.

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

from:

```powershell
D:\work\AGE-org\workers\ai
```

Run:

```powershell
docker compose config
```

from:

```powershell
D:\work\AGE-org
```

Expected:

- TypeScript typecheck exits 0;
- Vitest exits 0;
- Python pytest exits 0;
- Docker Compose config exits 0.

- [ ] **Step 2: Check git status**

Run:

```powershell
git status --short --branch
```

Expected: clean worktree, branch ahead of origin.

- [ ] **Step 3: Push branch**

Run:

```powershell
git push origin codex/iris-document-source-registry
```

Expected: push succeeds.

- [ ] **Step 4: Update PR body**

Read current body:

```powershell
gh pr view 3 --repo xfbbert-dotcom/iris --json body
```

Append summary line:

```markdown
- Add Phase 2S reindex DLQ management: internal list, replay, batch replay, and delete APIs for failed reindex jobs.
```

Run:

```powershell
gh pr edit 3 --repo xfbbert-dotcom/iris --body "<full updated body>"
```

- [ ] **Step 5: Verify PR status**

Run:

```powershell
gh pr view 3 --repo xfbbert-dotcom/iris --json number,state,isDraft,mergeable,headRefOid,url,body
```

Expected: PR is open, points at latest pushed head, and body includes Phase 2S.
