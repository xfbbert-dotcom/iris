# Iris Worker Loop Error Message Budget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bound batch-level worker loop error messages before they enter internal status snapshots.

**Architecture:** Add `normalizeWorkerErrorMessage` and use it in raw event, document sync, and
document reindex worker loops.

**Tech Stack:** TypeScript, Vitest, existing worker loop tests.

---

### Task 1: Write Failing Tests

**Files:**
- Modify: `apps/core/tests/raw-event-worker-loop.test.ts`
- Modify: `apps/core/tests/document-sync-worker-loop.test.ts`
- Modify: `apps/core/tests/document-reindex-worker-loop.test.ts`

- [x] **Step 1: Add raw event loop test**

Throw an oversized batch error and assert the failed latest batch snapshot stores a bounded message
with `[truncated]`.

- [x] **Step 2: Add document sync loop test**

Apply the same assertion to `DocumentSyncWorkerLoop`.

- [x] **Step 3: Add document reindex loop test**

Apply the same assertion to `DocumentReindexWorkerLoop`.

- [x] **Step 4: Run focused tests and confirm RED**

Run:

```powershell
npm --workspace apps/core test -- tests/raw-event-worker-loop.test.ts tests/document-sync-worker-loop.test.ts tests/document-reindex-worker-loop.test.ts
```

Expected: tests fail because failed batch snapshots currently store oversized thrown error messages
unchanged.

Observed: all three new tests failed with `1227` character `errorMessage` values.

### Task 2: Implement Worker Loop Error Budget

**Files:**
- Create: `apps/core/src/workers/worker-error-message.ts`
- Modify: `apps/core/src/events/raw-event-worker-loop.ts`
- Modify: `apps/core/src/documents/document-sync-worker-loop.ts`
- Modify: `apps/core/src/reindex/document-reindex-worker-loop.ts`

- [x] **Step 1: Add shared helper**

Implement a `1000` character worker-loop error budget with ` ... [truncated]`.

- [x] **Step 2: Apply to failed batch snapshots**

Use the helper when worker loops store `latestBatch.errorMessage`, while leaving `onError` hooks
unchanged.

- [x] **Step 3: Run focused tests and confirm GREEN**

Run:

```powershell
npm --workspace apps/core test -- tests/raw-event-worker-loop.test.ts tests/document-sync-worker-loop.test.ts tests/document-reindex-worker-loop.test.ts
```

Expected: the three worker loop test files pass.

Observed: focused worker loop tests passed with `27` tests.

### Task 3: Full Verification and Publication

**Files:**
- Create: `docs/superpowers/specs/2026-07-04-iris-worker-loop-error-message-budget-design.md`
- Create: `docs/superpowers/plans/2026-07-04-iris-worker-loop-error-message-budget.md`

- [x] **Step 1: Run full verification**

Run:

```powershell
npm run verify
```

Expected: the command exits 0.

Observed: `npm run verify` exited 0 with Core `776` passed / `4` skipped, Python `7` passed, and
`docker compose config` succeeded.

- [x] **Step 2: Commit, push, and verify PR checks**

Commit the worker loop error budget helper, push `codex/iris-document-source-registry`, update PR
#3, and confirm GitHub Actions Core and AI Worker checks pass.

Observed: committed `4135bc2`, pushed to `codex/iris-document-source-registry`, updated PR #3,
and confirmed GitHub Actions Core and AI Worker checks passed.
