# Iris Document Sync Worker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Consume queued document sync jobs and delegate each source to the existing `DocumentSyncRunner`.

**Architecture:** Add a worker over `DocumentSyncQueue.dequeueBatch` and `DocumentSyncRunner.syncSourceById`, then add a polling loop mirroring the existing raw event worker loop. Retry/DLQ and runtime startup stay out of scope.

**Tech Stack:** TypeScript, Vitest, existing document sync queue and runner interfaces.

---

## File Structure

- Create `apps/core/src/documents/document-sync-worker.ts`
  - Processes batches of `DocumentSyncJob`.
  - Delegates source decisions to `DocumentSyncRunner`.
  - Converts runner returns and thrown errors into worker result records.
- Create `apps/core/tests/document-sync-worker.test.ts`
  - Covers processed, runner-handled failed sync, thrown errors, and batch limit sanitization.
- Create `apps/core/src/documents/document-sync-worker-loop.ts`
  - Polls the worker on an interval.
  - Records latest batch snapshot.
  - Prevents overlapping batches.
- Create `apps/core/tests/document-sync-worker-loop.test.ts`
  - Mirrors raw event loop tests for polling, counts, errors, and overlap prevention.

## Task 1: Document Sync Worker

**Files:**
- Create: `apps/core/src/documents/document-sync-worker.ts`
- Test: `apps/core/tests/document-sync-worker.test.ts`

- [ ] **Step 1: Write failing worker tests**

Tests should assert:

- worker dequeues with sanitized limit;
- calls `syncSourceById(job.documentSourceId)`;
- runner status `synced` returns worker status `processed`;
- runner status `failed` still returns worker status `processed`;
- thrown runner errors return worker status `failed`;
- processing continues after a thrown error.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- document-sync-worker.test.ts`

Expected: FAIL because the worker file does not exist.

- [ ] **Step 3: Implement worker**

Create `createDocumentSyncWorker({ queue, runner })` with:

```ts
processBatch({ limit }): Promise<DocumentSyncWorkerResult[]>
```

Use `Math.max(0, Math.floor(limit))`. Catch runner throws per job and continue.

- [ ] **Step 4: Run worker tests**

Run: `npm test -- document-sync-worker.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/core/src/documents/document-sync-worker.ts apps/core/tests/document-sync-worker.test.ts
git commit -m "feat: add document sync worker"
```

## Task 2: Document Sync Worker Loop

**Files:**
- Create: `apps/core/src/documents/document-sync-worker-loop.ts`
- Test: `apps/core/tests/document-sync-worker-loop.test.ts`

- [ ] **Step 1: Write failing loop tests**

Tests should assert:

- loop polls worker after `start`;
- latest successful batch records processed/failed counts;
- batch-level thrown errors are recorded and polling continues;
- long-running batches do not overlap.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- document-sync-worker-loop.test.ts`

Expected: FAIL because the loop file does not exist.

- [ ] **Step 3: Implement loop**

Mirror `createRawEventWorkerLoop`, but import `DocumentSyncWorkerResult` and count statuses `processed` and `failed`.

- [ ] **Step 4: Run loop tests**

Run: `npm test -- document-sync-worker-loop.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/core/src/documents/document-sync-worker-loop.ts apps/core/tests/document-sync-worker-loop.test.ts
git commit -m "feat: add document sync worker loop"
```

## Task 3: Full Verification And PR Update

- [ ] **Step 1: Run TypeScript typecheck**

Run: `npm run typecheck`

Expected: exit 0.

- [ ] **Step 2: Run TypeScript tests**

Run: `npm test`

Expected: all tests pass.

- [ ] **Step 3: Run Python worker tests**

Run: `python -m pytest` from `workers/ai`

Expected: all tests pass.

- [ ] **Step 4: Run Docker Compose validation**

Run: `docker compose config`

Expected: exit 0.

- [ ] **Step 5: Push and update PR**

```bash
git push origin codex/iris-document-source-registry
gh pr edit 3 --repo xfbbert-dotcom/iris --body "<updated body with Phase 2Y summary>"
```

Expected: PR #3 contains Phase 2Y summary and checked test plan.

## Task 4: Direct Batch Limit Safe Integers

- [x] **Step 1: Add failing worker coverage**
  - Prove `Number.MAX_SAFE_INTEGER + 1` rejects before `DocumentSyncQueue.dequeueBatch()`.

- [x] **Step 2: Add safe-magnitude guard**
  - Reject unsafe finite direct `processBatch()` limits while preserving existing non-finite-to-zero behavior.

- [x] **Step 3: Verify focused and full suites**
  - Run focused document sync worker tests.
  - Run typecheck, Python tests, Docker Compose config, and full npm tests.

## Self-Review

- Spec coverage: worker, loop, failure strategy, non-overlap, and deferred runtime wiring are covered.
- Placeholder scan: no incomplete placeholder markers are present.
- Type consistency: `DocumentSyncWorker`, `DocumentSyncWorkerResult`, `DocumentSyncWorkerLoop`, `processBatch`, and `syncSourceById` names are consistent across tasks.
