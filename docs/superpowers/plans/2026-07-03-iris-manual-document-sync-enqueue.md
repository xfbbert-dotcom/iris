# Iris Manual Document Sync Enqueue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an internal API that lets operators manually enqueue a known document source for sync or re-sync.

**Architecture:** Add `manual_source_sync` as a document sync job reason, create a manual enqueue planner that validates source state and writes to the existing queue, expose the planner from `DocumentSyncRuntime`, then add a Fastify internal route.

**Tech Stack:** TypeScript, Fastify, Redis-backed document sync queue, Vitest.

---

### Task 1: Manual Sync Planner

**Files:**
- Modify: `apps/core/src/documents/document-sync-queue.ts`
- Modify: `apps/core/src/documents/redis-document-sync-queue.ts`
- Create: `apps/core/src/documents/manual-document-sync-planner.ts`
- Test: `apps/core/tests/redis-document-sync-queue.test.ts`
- Test: `apps/core/tests/manual-document-sync-planner.test.ts`

- [x] **Step 1: Write failing queue reason tests**

Add a Redis queue round-trip test for a job with `reason: "manual_source_sync"`.

- [x] **Step 2: Write failing planner tests**

Cover: enqueues pending sources, re-enqueues synced sources after marking pending, re-enqueues failed sources after marking pending, returns `not_found`, rejects denied/disabled sources, and skips syncing sources.

- [x] **Step 3: Add queue reason support**

Extend `DocumentSyncReason` and Redis parsing to accept `manual_source_sync`.

- [x] **Step 4: Implement planner**

Create `createManualDocumentSyncPlanner({ registry, queue, now, requestId })`.

- [x] **Step 5: Verify targeted tests**

Run:

```powershell
npm --workspace apps/core test -- tests/redis-document-sync-queue.test.ts tests/manual-document-sync-planner.test.ts
```

Expected: targeted tests pass.

### Task 2: Runtime And API

**Files:**
- Modify: `apps/core/src/runtime/document-sync-runtime.ts`
- Modify: `apps/core/src/app.ts`
- Test: `apps/core/tests/document-sync-runtime.test.ts`
- Test: `apps/core/tests/answer-draft-api.test.ts`

- [x] **Step 1: Write failing runtime tests**

Assert `runtime.enqueueSource({ documentSourceId })` delegates to the manual planner.

- [x] **Step 2: Write failing API tests**

Cover unavailable runtime, invalid ID, successful enqueue, not-found status, and operation failure for `POST /internal/document-sync/sources/:id/enqueue`.

- [x] **Step 3: Wire runtime planner**

Create the manual planner from the same document source registry and queue used by document sync runtime.

- [x] **Step 4: Add Fastify route**

Expose `POST /internal/document-sync/sources/:id/enqueue`.

- [x] **Step 5: Verify targeted tests**

Run:

```powershell
npm --workspace apps/core test -- tests/document-sync-runtime.test.ts tests/answer-draft-api.test.ts
```

Expected: targeted tests pass.

### Task 3: Full Verification And PR Update

**Files:**
- Modify: PR #3 body.

- [x] **Step 1: Run full verification**

Run:

```powershell
npm run typecheck
npm test
python -m pytest
docker compose config
```

Expected: all commands exit 0.

- [x] **Step 2: Commit and push**

Commit the docs and implementation, then push `codex/iris-document-source-registry`.

- [x] **Step 3: Update PR body and inspect PR state**

Append Phase 3G summary and verify PR #3 remains open and non-draft.
