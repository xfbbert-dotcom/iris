# Iris Reindex DLQ Replay Loss Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this
> plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure Redis document reindex DLQ replay never deletes a dead-letter payload before the
replacement reindex job is accepted by the queue.

**Architecture:** Keep the existing reindex DLQ API and queue contract. Change only Redis replay
ordering: find the stored DLQ payload, validate it is replayable, enqueue the reset job, then remove
the DLQ payload. If enqueue fails, the DLQ payload remains available for another replay attempt.

**Tech Stack:** TypeScript, Vitest, Redis list/set queue adapter.

---

### Task 1: Regression Test

**Files:**
- Modify: `apps/core/tests/redis-document-reindex-queue.test.ts`

- [x] **Step 1: Write failing test**

Add a Redis reindex DLQ replay test where queue `eval` throws and assert `lRem` is not called.

- [x] **Step 2: Verify red**

Run:

```powershell
npm test -- tests/redis-document-reindex-queue.test.ts
```

Expected: the new test fails because replay currently removes the DLQ payload first.

### Task 2: Replay Ordering Fix

**Files:**
- Modify: `apps/core/src/reindex/redis-document-reindex-queue.ts`
- Modify: `docs/superpowers/specs/2026-07-02-iris-reindex-dlq-management-design.md`

- [x] **Step 1: Enqueue before delete**

Move `lRem` after `enqueueSerializedJob` in Redis `replayDeadLetter`.

- [x] **Step 2: Document invariant**

Record that Redis reindex replay must preserve the DLQ payload when enqueue fails.

- [x] **Step 3: Verify targeted test**

Run:

```powershell
npm test -- tests/redis-document-reindex-queue.test.ts
```

Expected: all Redis document reindex queue tests pass.
