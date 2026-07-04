# Iris Dead Letter Error Message Budget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bound DLQ error messages before queues persist or list them.

**Architecture:** Add `normalizeDeadLetterErrorMessage` and use it in raw event, document sync, and
document reindex queues across Redis and in-memory implementations.

**Tech Stack:** TypeScript, Vitest, existing queue tests.

---

### Task 1: Write Failing Tests

**Files:**
- Create: `apps/core/tests/dead-letter-error-message.test.ts`
- Modify: `apps/core/tests/redis-raw-event-queue.test.ts`

- [x] **Step 1: Add helper tests**

Assert short messages trim, blank messages return `unknown error`, and oversized messages are at
most `1000` characters with a visible truncation marker.

- [x] **Step 2: Add Redis raw DLQ integration test**

Dead-letter a raw event with an oversized `errorMessage` and assert the serialized Redis payload has
a bounded message with `[truncated]` and without trailing diagnostic detail.

- [x] **Step 3: Run focused tests and confirm RED**

Run:

```powershell
npm --workspace apps/core test -- dead-letter-error-message.test.ts redis-raw-event-queue.test.ts -t "dead-letter errors|bounds failed raw event DLQ error messages"
```

Expected: tests fail because the helper does not exist and Redis raw DLQ stores the full message.

Observed: helper suite failed to load the missing module, and the Redis raw DLQ integration test
stored a `1227` character error message.

### Task 2: Implement Queue Error Budget

**Files:**
- Create: `apps/core/src/queues/dead-letter-error-message.ts`
- Modify: `apps/core/src/events/in-memory-raw-event-queue.ts`
- Modify: `apps/core/src/events/redis-raw-event-queue.ts`
- Modify: `apps/core/src/documents/in-memory-document-sync-queue.ts`
- Modify: `apps/core/src/documents/redis-document-sync-queue.ts`
- Modify: `apps/core/src/reindex/in-memory-document-reindex-queue.ts`
- Modify: `apps/core/src/reindex/redis-document-reindex-queue.ts`

- [x] **Step 1: Add helper**

Implement a `1000` character DLQ error budget with ` ... [truncated]`.

- [x] **Step 2: Apply to queue writes**

Normalize error messages before in-memory and Redis queues store failed jobs/events.

- [x] **Step 3: Apply to Redis DLQ parsing**

Normalize existing Redis DLQ error messages when listing replayable, legacy, or invalid diagnostic
entries.

- [x] **Step 4: Run focused tests and confirm GREEN**

Run:

```powershell
npm --workspace apps/core test -- dead-letter-error-message.test.ts redis-raw-event-queue.test.ts -t "dead-letter errors|bounds failed raw event DLQ error messages"
npm --workspace apps/core test -- raw-event-queue.test.ts redis-raw-event-queue.test.ts document-sync-queue.test.ts redis-document-sync-queue.test.ts document-reindex-queue.test.ts redis-document-reindex-queue.test.ts
```

Expected: focused and queue test files pass.

Observed: focused tests passed, and six queue test files passed with `146` tests.

### Task 3: Full Verification and Publication

**Files:**
- Create: `docs/superpowers/specs/2026-07-04-iris-dead-letter-error-message-budget-design.md`
- Create: `docs/superpowers/plans/2026-07-04-iris-dead-letter-error-message-budget.md`

- [x] **Step 1: Run full verification**

Run:

```powershell
npm run verify
```

Expected: the command exits 0.

Observed: `npm run verify` exited 0 with Core `771` passed / `4` skipped, Python `7` passed, and
`docker compose config` succeeded.

- [ ] **Step 2: Commit, push, and verify PR checks**

Commit the DLQ error message budget helper, push `codex/iris-document-source-registry`, update PR
#3, and confirm GitHub Actions Core and AI Worker checks pass.
