# Iris Document Sync Retry And DLQ Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Retry thrown document sync worker failures and move exhausted jobs to a DLQ.

**Architecture:** Extend the existing `DocumentSyncQueue` contract in the same style as raw event and reindex queues, update Redis/in-memory implementations, then make `DocumentSyncWorker` delegate thrown runner failures to queue policy. Runtime status reads both pending and dead-letter counts.

**Tech Stack:** TypeScript, Vitest, Redis queue client abstractions.

---

## File Structure

- Modify `apps/core/src/documents/document-sync-queue.ts`: add failure result types and queue methods.
- Modify `apps/core/src/documents/in-memory-document-sync-queue.ts`: implement retry/DLQ in memory.
- Modify `apps/core/tests/document-sync-queue.test.ts`: cover in-memory retry and DLQ.
- Modify `apps/core/src/documents/redis-document-sync-queue.ts`: implement retry/DLQ.
- Modify `apps/core/tests/redis-document-sync-queue.test.ts`: cover Redis retry and DLQ count.
- Modify `apps/core/src/documents/document-sync-worker.ts`: call `handleFailedJob` on thrown runner errors.
- Modify `apps/core/tests/document-sync-worker.test.ts`: assert requeue/dead-letter actions.
- Modify `apps/core/src/runtime/document-sync-runtime.ts`: include `deadLetterJobCount`.
- Modify `apps/core/tests/document-sync-runtime.test.ts`: assert status includes DLQ count and Redis client exposes `rPush`.
- Modify `apps/core/tests/answer-draft-api.test.ts`: status API serializes `deadLetterJobCount`.

---

### Task 1: Queue Contracts And Implementations

- [ ] **Step 1: Write failing queue tests**

Add tests for in-memory and Redis failed-job handling.

- [ ] **Step 2: Run queue tests**

Run:

```bash
npm test -- document-sync-queue.test.ts redis-document-sync-queue.test.ts
```

Expected: FAIL because queue contracts do not have failed-job methods.

- [ ] **Step 3: Implement queue contracts**

Add `handleFailedJob` and `getDeadLetterCount` to `DocumentSyncQueue`, then implement them in memory and Redis.

- [ ] **Step 4: Run queue tests**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/core/src/documents/document-sync-queue.ts apps/core/src/documents/in-memory-document-sync-queue.ts apps/core/src/documents/redis-document-sync-queue.ts apps/core/tests/document-sync-queue.test.ts apps/core/tests/redis-document-sync-queue.test.ts
git commit -m "feat: add document sync retry queue policy"
```

---

### Task 2: Worker Failure Policy

- [ ] **Step 1: Write failing worker tests**

Update thrown runner failure tests to expect queue `handleFailedJob` and retry action metadata.

- [ ] **Step 2: Run worker tests**

Run:

```bash
npm test -- document-sync-worker.test.ts
```

Expected: FAIL because worker only returns failed results.

- [ ] **Step 3: Implement worker policy**

Require `handleFailedJob` in queue dependency and include `retryAction`/`attempts` in failed results.

- [ ] **Step 4: Run worker tests**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/core/src/documents/document-sync-worker.ts apps/core/tests/document-sync-worker.test.ts
git commit -m "feat: retry failed document sync jobs"
```

---

### Task 3: Runtime Status

- [ ] **Step 1: Write failing runtime/API tests**

Assert `DocumentSyncRuntime.getStatus()` and `/internal/document-sync/status` include `deadLetterJobCount`.

- [ ] **Step 2: Run runtime/API tests**

Run:

```bash
npm test -- document-sync-runtime.test.ts answer-draft-api.test.ts
```

Expected: FAIL because runtime status does not read DLQ count.

- [ ] **Step 3: Implement runtime status**

Add `getDeadLetterCount()` to queue type and status response.

- [ ] **Step 4: Run runtime/API tests**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/core/src/runtime/document-sync-runtime.ts apps/core/tests/document-sync-runtime.test.ts apps/core/tests/answer-draft-api.test.ts
git commit -m "feat: expose document sync DLQ status"
```

---

### Task 4: Verification And PR Update

Run:

```bash
npm run typecheck
npm test
python -m pytest
docker compose config
```

Then push and add PR summary:

```markdown
- Add Phase 3E document sync retry and DLQ: thrown worker failures are retried, dead-lettered at max attempts, and surfaced in document sync status.
```

---

## Self-Review

- Spec coverage: queue policy, worker integration, runtime status, and verification are covered.
- Placeholder scan: no placeholders remain.
- Type consistency: failure types, queue methods, worker retry action, and status field names are consistent.
