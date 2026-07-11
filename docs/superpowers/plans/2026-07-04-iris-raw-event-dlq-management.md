# Iris Raw Event DLQ Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this
> plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add internal list/replay/delete/batch-replay support for Feishu raw event DLQ items.

**Architecture:** Extend the `RawEventQueue` boundary with DLQ management methods, implement them
for in-memory and Redis queues, expose them through `EventWorkerRuntime.deadLetters`, and add
Fastify internal routes under `/internal/events/dead-letters`.

**Tech Stack:** TypeScript, Fastify app injection tests, Vitest, Redis list/set queue adapter.

---

### Task 1: Queue Contract And In-Memory DLQ

**Files:**
- Modify: `apps/core/src/events/raw-event-queue.ts`
- Modify: `apps/core/src/events/in-memory-raw-event-queue.ts`
- Test: `apps/core/tests/raw-event-queue.test.ts`

- [x] **Step 1: Write failing in-memory DLQ tests**

Cover list, replay with attempts reset, delete, and batch replay.

- [x] **Step 2: Extend raw event queue types**

Add `RawEventDeadLetter`, invalid raw payload diagnostics, and batch replay result types.

- [x] **Step 3: Implement in-memory DLQ management**

Store dead letters with generated IDs and expose list/replay/delete/batch replay.

### Task 2: Redis DLQ Management

**Files:**
- Modify: `apps/core/src/events/redis-raw-event-queue.ts`
- Test: `apps/core/tests/redis-raw-event-queue.test.ts`

- [x] **Step 1: Write failing Redis DLQ tests**

Cover stable IDs, replay with attempts reset, enqueue-before-delete failure preservation, invalid
payload diagnostics, legacy non-replayable items, delete, and batch replay.

- [x] **Step 2: Implement Redis DLQ methods**

Use `lRange`/`lRem`, generated IDs for new DLQ items, legacy synthetic IDs for diagnostics, and
enqueue-before-delete replay ordering.

### Task 3: Runtime And API

**Files:**
- Modify: `apps/core/src/runtime/event-worker-runtime.ts`
- Modify: `apps/core/src/app.ts`
- Test: `apps/core/tests/event-worker-runtime.test.ts`
- Test: `apps/core/tests/answer-draft-api.test.ts`

- [x] **Step 1: Expose runtime facade**

Add `EventWorkerRuntime.deadLetters` and extend the lazy Redis client with `lRange`/`lRem`.

- [x] **Step 2: Add internal routes**

Add list, replay, delete, and batch replay under `/internal/events/dead-letters`.

- [x] **Step 3: Verify targeted tests**

Run focused raw event queue, runtime, and API tests.

### Task 4: Full Verification And PR Update

**Files:**
- Modify: PR #3 body.

- [x] **Step 1: Run full verification**

Run:

```powershell
npm run typecheck
npm test
python -m pytest
docker compose config
```

- [x] **Step 2: Commit, push, and verify PR checks**

Commit the implementation, push `codex/iris-document-source-registry`, and confirm GitHub Actions
returns Core and AI Worker success.
