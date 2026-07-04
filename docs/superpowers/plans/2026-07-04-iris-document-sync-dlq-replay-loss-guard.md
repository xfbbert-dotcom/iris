# Iris Document Sync DLQ Replay Loss Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this
> plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure Redis document sync DLQ replay never deletes a dead-letter payload before the
replacement job is safely enqueued.

**Architecture:** Keep the existing DLQ API and queue contract. Change only Redis replay ordering:
find the stored DLQ payload, validate it is replayable, enqueue the job with `attempts: 0`, then
remove the DLQ payload. If enqueue fails, the DLQ payload remains in place.

**Tech Stack:** TypeScript, Vitest, Redis list/set queue adapter.

---

### Task 1: Regression Test

**Files:**
- Modify: `apps/core/tests/redis-document-sync-queue.test.ts`

- [x] **Step 1: Write failing test**

Add a Redis DLQ replay test where `eval` throws during enqueue and assert `lRem` is not called.

- [x] **Step 2: Verify red**

Run:

```powershell
npm test -- tests/redis-document-sync-queue.test.ts
```

Expected: the new test fails because replay currently removes the DLQ payload first.

### Task 2: Replay Ordering Fix

**Files:**
- Modify: `apps/core/src/documents/redis-document-sync-queue.ts`
- Modify: `docs/superpowers/specs/2026-07-03-iris-document-sync-dlq-management-design.md`

- [x] **Step 1: Enqueue before delete**

Move `lRem` after `enqueueSerializedJob` in Redis `replayDeadLetter`.

- [x] **Step 2: Document invariant**

Record that Redis replay must preserve the DLQ payload when enqueue fails.

- [x] **Step 3: Verify targeted test**

Run:

```powershell
npm test -- tests/redis-document-sync-queue.test.ts
```

Expected: all Redis document sync queue tests pass.
