# Iris Worker Result Error Message Budget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bound per-job worker error messages before they are returned or passed into failure
handlers.

**Architecture:** Generalize the worker error helper to `normalizeWorkerErrorMessage` and use it in
raw event, document sync, and document reindex workers, while keeping worker loops on the same
helper.

**Tech Stack:** TypeScript, Vitest, existing worker and worker loop tests.

---

### Task 1: Write Failing Tests

**Files:**
- Modify: `apps/core/tests/raw-event-worker.test.ts`
- Modify: `apps/core/tests/document-sync-worker.test.ts`
- Modify: `apps/core/tests/document-reindex-worker.test.ts`

- [x] **Step 1: Add raw event worker test**

Throw an oversized processor error and assert the failed worker result and `handleFailedEvent`
message are bounded.

- [x] **Step 2: Add document sync worker test**

Throw an oversized runner error and assert the failed worker result and `handleFailedJob` message
are bounded.

- [x] **Step 3: Add document reindex worker test**

Throw an oversized indexing error and assert the failed worker result and `handleFailedJob` message
are bounded.

- [x] **Step 4: Run focused tests and confirm RED**

Run:

```powershell
npm --workspace apps/core test -- tests/raw-event-worker.test.ts tests/document-sync-worker.test.ts tests/document-reindex-worker.test.ts
```

Expected: tests fail because direct worker results currently return full thrown error messages.

Observed: all three new tests failed with `1227` character `errorMessage` values.

### Task 2: Implement Worker Result Error Budget

**Files:**
- Create: `apps/core/src/workers/worker-error-message.ts`
- Delete: `apps/core/src/workers/worker-loop-error-message.ts`
- Modify: `apps/core/src/events/raw-event-worker.ts`
- Modify: `apps/core/src/documents/document-sync-worker.ts`
- Modify: `apps/core/src/reindex/document-reindex-worker.ts`
- Modify: `apps/core/src/events/raw-event-worker-loop.ts`
- Modify: `apps/core/src/documents/document-sync-worker-loop.ts`
- Modify: `apps/core/src/reindex/document-reindex-worker-loop.ts`

- [x] **Step 1: Generalize helper**

Replace the loop-specific helper with `normalizeWorkerErrorMessage`.

- [x] **Step 2: Apply to direct workers**

Normalize per-job failure messages before passing them to queue failure handlers and returning
failed worker results.

- [x] **Step 3: Keep loops on the shared helper**

Update worker loops to use the generalized helper so loop snapshots and direct worker results share
one budget.

- [x] **Step 4: Run focused tests and confirm GREEN**

Run:

```powershell
npm --workspace apps/core test -- tests/raw-event-worker.test.ts tests/document-sync-worker.test.ts tests/document-reindex-worker.test.ts tests/raw-event-worker-loop.test.ts tests/document-sync-worker-loop.test.ts tests/document-reindex-worker-loop.test.ts
```

Expected: worker and worker loop test files pass.

Observed: focused tests passed with `48` tests.

### Task 3: Full Verification and Publication

**Files:**
- Create: `docs/superpowers/specs/2026-07-04-iris-worker-result-error-message-budget-design.md`
- Create: `docs/superpowers/plans/2026-07-04-iris-worker-result-error-message-budget.md`
- Modify: `docs/superpowers/specs/2026-07-04-iris-worker-loop-error-message-budget-design.md`
- Modify: `docs/superpowers/plans/2026-07-04-iris-worker-loop-error-message-budget.md`

- [x] **Step 1: Run full verification**

Run:

```powershell
npm run verify
```

Expected: the command exits 0.

Observed: `npm run verify` exited 0 with Core `780` passed / `4` skipped, Python `7` passed, and
`docker compose config` succeeded.

- [x] **Step 2: Commit, push, and verify PR checks**

Commit the worker result error budget helper, push `codex/iris-document-source-registry`, update
PR #3, and confirm GitHub Actions Core and AI Worker checks pass.

Observed: committed `3734339`, pushed to `codex/iris-document-source-registry`, updated PR #3,
and confirmed GitHub Actions Core and AI Worker checks passed.
