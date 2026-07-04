# Iris Worker Job ID Budget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bound document sync and document reindex queue job identifiers before worker processing.

**Architecture:** Apply a shared `512` character ID component budget and validate queued
idempotency keys against canonical keys recomputed from bounded fields.

**Tech Stack:** TypeScript, Vitest, existing Redis document sync/reindex queue tests.

---

### Task 1: Write Failing Tests

**Files:**
- Modify: `apps/core/tests/redis-document-sync-queue.test.ts`
- Modify: `apps/core/tests/redis-document-reindex-queue.test.ts`

- [x] **Step 1: Add document sync ID budget tests**

Assert `createDocumentSyncIdempotencyKey` rejects oversized document source IDs and
`parseDocumentSyncJob` rejects oversized queued identifiers.

- [x] **Step 2: Add document reindex ID budget tests**

Assert `createDocumentReindexIdempotencyKey` rejects oversized embedding profile and document
snapshot IDs, and `parseDocumentReindexJob` rejects oversized queued identifiers.

- [x] **Step 3: Run focused tests and confirm RED**

Run:

```powershell
npm --workspace apps/core test -- redis-document-sync-queue.test.ts redis-document-reindex-queue.test.ts
```

Expected: the new tests fail because queue ID helpers and parsers currently only check non-empty
strings.

Observed: focused tests failed because oversized ID helpers and queued identifiers were accepted.

### Task 2: Implement Job ID Budgets

**Files:**
- Modify: `apps/core/src/documents/document-sync-queue.ts`
- Modify: `apps/core/src/documents/redis-document-sync-queue.ts`
- Modify: `apps/core/src/reindex/document-reindex-queue.ts`
- Modify: `apps/core/src/reindex/redis-document-reindex-queue.ts`

- [x] **Step 1: Add public queue ID budget constants**

Add `512` character ID component budgets and derived idempotency key budgets for document sync and
document reindex jobs.

- [x] **Step 2: Bound idempotency helper inputs**

Reject oversized IDs in `createDocumentSyncIdempotencyKey` and
`createDocumentReindexIdempotencyKey`.

- [x] **Step 3: Bound queued payload identifiers**

Read queued identifiers once, reject blank or oversized values, and return only validated strings.

- [x] **Step 4: Validate idempotency consistency**

Recompute canonical idempotency keys from bounded fields and reject queued payloads whose
`idempotencyKey` does not match.

- [x] **Step 5: Run focused tests and confirm GREEN**

Run:

```powershell
npm --workspace apps/core test -- redis-document-sync-queue.test.ts redis-document-reindex-queue.test.ts
```

Expected: focused Redis document sync and reindex queue tests pass.

Observed: focused tests passed with `70` tests.

### Task 3: Full Verification and Publication

**Files:**
- Create: `docs/superpowers/specs/2026-07-04-iris-worker-job-id-budget-design.md`
- Create: `docs/superpowers/plans/2026-07-04-iris-worker-job-id-budget.md`

- [x] **Step 1: Run full verification**

Run:

```powershell
npm run verify
```

Expected: the command exits 0.

Observed: `npm run verify` exited 0 with Core `817` passed / `4` skipped, Python `7` passed, and
`docker compose config` succeeded.

- [ ] **Step 2: Commit, push, and verify PR checks**

Commit the worker job ID budget patch, push `codex/iris-document-source-registry`, update PR #3,
and confirm GitHub Actions Core and AI Worker checks pass.
