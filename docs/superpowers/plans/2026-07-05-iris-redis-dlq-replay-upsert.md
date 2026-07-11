# Iris Redis DLQ Replay Upsert Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent Redis DLQ replay from deleting recovery items when a stale `seen` key blocks the
normal enqueue path.

**Architecture:** Reuse the existing Redis retry/upsert Lua scripts for DLQ replay across raw event,
document sync, and document reindex queues. Keep normal enqueue unchanged.

**Tech Stack:** TypeScript, Redis queue unit tests, Vitest.

---

### Task 1: Write Failing Redis Replay Tests

**Files:**
- Modify: `apps/core/tests/redis-raw-event-queue.test.ts`
- Modify: `apps/core/tests/redis-document-sync-queue.test.ts`
- Modify: `apps/core/tests/redis-document-reindex-queue.test.ts`

- [x] **Step 1: Add raw event stale-seen replay test**

Use a fake Redis client whose `seen` set already contains the DLQ event key while the queue list is
empty. Replay `dlq-1` and expect the replay payload to be pushed and the DLQ payload removed.

- [x] **Step 2: Add document sync stale-seen replay test**

Use the same fake-client shape for a document sync DLQ item. Expect replay to push
`serializeDocumentSyncJob(job({ attempts: 0 }))` despite the stale `seen` key.

- [x] **Step 3: Add reindex stale-seen replay test**

Use the same fake-client shape for a reindex DLQ item. Expect replay to push
`serializeDocumentReindexJob(jobFixture({ attempts: 0 }))` despite the stale `seen` key.

- [x] **Step 4: Run focused tests and confirm RED**

Run:

```powershell
npm --workspace apps/core test -- redis-raw-event-queue.test.ts redis-document-sync-queue.test.ts redis-document-reindex-queue.test.ts -t "seen key is stale"
```

Observed RED: all three tests failed because replay used the normal enqueue script and silently no-oped
when a stale `seen` key existed.

### Task 2: Use Upsert Replay

**Files:**
- Modify: `apps/core/src/events/redis-raw-event-queue.ts`
- Modify: `apps/core/src/documents/redis-document-sync-queue.ts`
- Modify: `apps/core/src/reindex/redis-document-reindex-queue.ts`

- [x] **Step 1: Change raw event DLQ replay**

Replace `enqueueSerializedRawEvent` with `upsertRetryingSerializedRawEvent` in `replayDeadLetter`.

- [x] **Step 2: Change document sync DLQ replay**

Replace `enqueueSerializedJob` with `upsertRetryingSerializedJob` in `replayDeadLetter`.

- [x] **Step 3: Change reindex DLQ replay**

Replace `enqueueSerializedJob` with `upsertRetryingSerializedJob` in `replayDeadLetter`.

- [x] **Step 4: Run focused tests and confirm GREEN**

Run the same focused stale-seen test command. Observed GREEN: 3 tests passed, 115 skipped.

### Task 3: Verification and Publication

**Files:**
- Create: `docs/superpowers/specs/2026-07-05-iris-redis-dlq-replay-upsert-design.md`
- Create: `docs/superpowers/plans/2026-07-05-iris-redis-dlq-replay-upsert.md`

- [x] **Step 1: Run queue tests**

Run:

```powershell
npm --workspace apps/core test -- redis-raw-event-queue.test.ts redis-document-sync-queue.test.ts redis-document-reindex-queue.test.ts
```

Observed: all Redis queue tests passed, 118 passed.

- [x] **Step 2: Run full verification**

Run:

```powershell
npm run verify
```

Observed: `npm run verify` passed with 65 core test files, 1009 passed / 4 skipped, 7 Python
worker tests passed, and Docker Compose config rendered successfully.

- [ ] **Step 3: Commit, push, update PR, and verify checks**

Commit the Redis DLQ replay upsert fix, push `codex/iris-document-source-registry`, update PR #3,
and confirm GitHub Actions Core and AI Worker checks pass.
