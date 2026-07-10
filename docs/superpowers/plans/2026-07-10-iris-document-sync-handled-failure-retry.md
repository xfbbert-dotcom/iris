# Iris Document Sync Handled Failure Retry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route durably recorded document fetch failures through the existing bounded queue retry
and DLQ policy instead of acknowledging them as successful work.

**Architecture:** Keep the runner's structured failure result, classify it in the queue worker,
and ACK only terminal non-failure results. Reuse existing queue failure handling and operator
surfaces without changing persistence or queue schemas.

**Tech Stack:** TypeScript, Vitest, existing document-sync queue and worker contracts.

## Global Constraints

- Preserve the runner's structured `status: "failed"` result for direct callers.
- Never call `handleProcessedJob` for a runner result with `status: "failed"`.
- Use the existing `handleFailedJob` retry/DLQ policy and bounded error message.
- Preserve ACK behavior for `synced`, `skipped`, `rejected`, and `not_found`.
- Preserve thrown runner error, ACK error, retry idempotency, and DLQ behavior.
- Do not add a scheduler, schema, queue, retry limit, or backoff policy.

---

### Task 1: Specify Handled Failure Routing

**Files:**
- Add: `docs/superpowers/specs/2026-07-10-iris-document-sync-handled-failure-retry-design.md`
- Add: `docs/superpowers/plans/2026-07-10-iris-document-sync-handled-failure-retry.md`
- Modify: `docs/superpowers/specs/2026-06-30-iris-architecture-whitepaper.md`

- [x] **Step 1: Record the ACK-without-retry failure mode**
- [x] **Step 2: Compare worker classification, runner throwing, and failed-source scanning**
- [x] **Step 3: Select explicit worker classification using the existing queue policy**
- [x] **Step 4: Commit the reviewed design and plan**

### Task 2: Drive The Worker Contract With Failing Tests

**Files:**
- Modify: `apps/core/tests/document-sync-worker.test.ts`

**Interfaces:**
- Consumes: `DocumentSyncRunner.syncSourceById()` and `DocumentSyncQueue.handleFailedJob()`.
- Produces: regression coverage for runner-handled `failed` results.

- [x] **Step 1: Replace the processed-failure expectation with retry and DLQ cases**

Use a table with `{ action: "requeued", attempts: 1 }` and
`{ action: "dead_lettered", attempts: 3 }`. For each case, return a runner result with
`status: "failed"` and `errorMessage: "fetch failed"`; expect worker `status: "failed"`, matching
retry metadata, `handleFailedJob({ job, errorMessage: "fetch failed" })`, and no processed ACK.

- [x] **Step 2: Run the focused worker test and verify RED**

Run:

```powershell
npm --workspace apps/core test -- tests/document-sync-worker.test.ts --reporter=dot
```

Expected: the new cases fail because the worker returns `processed`, calls `handleProcessedJob`,
and never calls `handleFailedJob`.

Observed RED: both `requeued` and `dead_lettered` cases received the existing
`{ status: "processed", syncStatus: "failed" }` result instead of queue failure metadata. The
other eight worker tests remained green.

### Task 3: Implement Explicit Result Classification

**Files:**
- Modify: `apps/core/src/documents/document-sync-worker.ts`

**Interfaces:**
- Consumes: runner `DocumentSyncResult` and existing `handleFailedJobWithRetry()`.
- Produces: queue failure results for both returned sync failures and thrown processing failures.

- [x] **Step 1: Separate runner invocation from result finalization**

Capture runner throws with the existing worker-failure path. After a successful runner call,
branch on `result.status` before processed ACK.

- [x] **Step 2: Route `status: "failed"` through queue failure handling**

Pass the runner's `errorMessage` to `handleFailedJobWithRetry()` and return the existing worker
failed result shape with `retryAction` and `attempts`. Keep the failure-handler call outside a
catch region that would submit its own errors a second time.

- [x] **Step 3: Preserve terminal processed ACK behavior**

For `synced`, `skipped`, `rejected`, and `not_found`, call `handleProcessedJob()` and return the
existing processed result unchanged.

- [x] **Step 4: Run focused tests and type checking and verify GREEN**

Run:

```powershell
npm --workspace apps/core test -- tests/document-sync-worker.test.ts tests/document-sync-pipeline.test.ts --reporter=dot
npm run typecheck
```

Expected: all focused tests and type checking pass.

Observed GREEN: the worker and pipeline files passed all `37/37` focused tests, including both
handled-failure queue outcomes, and TypeScript type checking completed successfully.

### Task 4: Verify, Review, And Publish

- [x] **Step 1: Run `npm run verify`**
- [x] **Step 2: Complete independent review and address findings**
- [ ] **Step 3: Commit and push the implementation**
- [ ] **Step 4: Watch PR #3 checks and confirm a clean merge state**

Observed full verification: `git diff --check`, TypeScript type checking, all 65 Core test files
(`1069` passed and `4` skipped), all 7 Python tests, and `docker compose config` completed
successfully.

The first independent review found no runtime defect but required direct regression coverage for
the rearranged exception boundaries. Added tests now prove the three-attempt failure-handler cap,
ACK-error routing, continuation after a handled failed item, and terminal ACK behavior for
`rejected` and `not_found`. The processed result type also excludes the impossible `failed` sync
status. Updated focused verification passed `42/42` tests and type checking.

Re-review found no remaining Critical, Important, or Minor issues and assessed the implementation
as ready to merge. A fresh full verification after all review fixes produced the result recorded
above.
