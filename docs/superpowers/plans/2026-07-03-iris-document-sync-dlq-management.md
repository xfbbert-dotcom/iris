# Iris Document Sync DLQ Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add internal DLQ management for document sync jobs: list, replay, batch replay, and delete.

**Architecture:** Extend the document sync queue contract with DLQ operations, implement them for Redis and in-memory queues, expose them through `DocumentSyncRuntime.deadLetters`, and mirror the reindex internal API routes in Fastify.

**Tech Stack:** TypeScript, Fastify, Redis list primitives, Vitest.

---

### Task 1: Queue Contract And Storage

**Files:**
- Modify: `apps/core/src/documents/document-sync-queue.ts`
- Modify: `apps/core/src/documents/redis-document-sync-queue.ts`
- Modify: `apps/core/src/documents/in-memory-document-sync-queue.ts`
- Test: `apps/core/tests/redis-document-sync-queue.test.ts`
- Test: `apps/core/tests/document-sync-queue.test.ts`

- [x] **Step 1: Write failing Redis DLQ tests**

Add tests proving stable IDs are stored, list returns replayable entries, legacy entries are listable but unsupported, replay resets attempts, delete removes entries, and batch replay reports not-found/legacy IDs.

- [x] **Step 2: Write failing in-memory DLQ tests**

Add tests proving in-memory DLQ entries can be listed, replayed, and deleted.

- [x] **Step 3: Extend the queue contract**

Add `DocumentSyncDeadLetter`, `ReplayDocumentSyncDeadLettersResult`, and the four DLQ methods to `DocumentSyncQueue`.

- [x] **Step 4: Implement Redis DLQ management**

Use `lRange` and `lRem`, stable IDs, legacy synthetic IDs, and attempts reset on replay.

- [x] **Step 5: Implement in-memory DLQ management**

Store stable IDs in memory and keep replay/delete behavior aligned with Redis.

- [x] **Step 6: Verify targeted queue tests**

Run:

```powershell
npm test -- apps/core/tests/redis-document-sync-queue.test.ts apps/core/tests/document-sync-queue.test.ts
```

Expected: queue tests pass.

### Task 2: Runtime Facade

**Files:**
- Modify: `apps/core/src/runtime/document-sync-runtime.ts`
- Modify: `apps/core/src/runtime/event-worker-runtime.ts`
- Test: `apps/core/tests/document-sync-runtime.test.ts`
- Test: `apps/core/tests/event-worker-runtime.test.ts`

- [x] **Step 1: Write failing runtime tests**

Assert `runtime.deadLetters.list/replay/delete/replayBatch` delegates to queue methods.

- [x] **Step 2: Extend runtime types**

Expose the `deadLetters` facade and extend the lazy Redis sync client with `lRange`/`lRem`.

- [x] **Step 3: Verify targeted runtime tests**

Run:

```powershell
npm test -- apps/core/tests/document-sync-runtime.test.ts apps/core/tests/event-worker-runtime.test.ts
```

Expected: runtime tests pass.

### Task 3: Internal API Routes

**Files:**
- Modify: `apps/core/src/app.ts`
- Test: `apps/core/tests/answer-draft-api.test.ts`

- [x] **Step 1: Write failing API tests**

Cover unavailable runtime, listing, invalid limits, single replay, delete, batch replay, invalid batch body, and operation failures.

- [x] **Step 2: Add routes**

Mirror the reindex DLQ API pattern under `/internal/document-sync/dead-letters`.

- [x] **Step 3: Verify targeted API tests**

Run:

```powershell
npm test -- apps/core/tests/answer-draft-api.test.ts
```

Expected: API tests pass.

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

Expected: all commands exit 0.

- [x] **Step 2: Commit and push**

Commit the implementation and push `codex/iris-document-source-registry`.

- [x] **Step 3: Update PR body and inspect PR state**

Append Phase 3F summary and verify PR #3 remains open and non-draft.
