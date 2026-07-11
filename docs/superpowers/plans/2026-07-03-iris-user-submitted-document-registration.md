# Iris User Submitted Document Registration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an internal API that registers one user-submitted document source and enqueues it for sync.

**Architecture:** Extend `DocumentSyncRuntime` with `registerUserSubmittedDocument`, backed by the existing document source registry and manual sync planner. Add a Fastify route that validates `{ sourceUri, submittedByUserId, title? }` and returns the registered source plus enqueue result.

**Tech Stack:** TypeScript, Fastify, Postgres-backed document source registry, Redis document sync queue, Vitest.

---

### Task 1: Runtime Method

**Files:**
- Modify: `apps/core/src/runtime/document-sync-runtime.ts`
- Test: `apps/core/tests/document-sync-runtime.test.ts`

- [x] **Step 1: Write failing runtime test**

Assert `runtime.registerUserSubmittedDocument({ sourceUri, submittedByUserId, title, observedAt })` calls `documentSources.registerUserSubmittedDocument` and then `manualPlanner.enqueueSource`.

- [x] **Step 2: Extend runtime types and composition**

Add the method to `DocumentSyncRuntime`, widen the document source registry dependency type, and implement the method by registering then enqueueing.

- [x] **Step 3: Verify runtime test**

Run:

```powershell
npm --workspace apps/core test -- tests/document-sync-runtime.test.ts
```

Expected: runtime tests pass.

### Task 2: Internal API

**Files:**
- Modify: `apps/core/src/app.ts`
- Test: `apps/core/tests/answer-draft-api.test.ts`

- [x] **Step 1: Write failing API tests**

Cover unavailable runtime, successful registration, invalid body, and runtime failure.

- [x] **Step 2: Add route**

Add `POST /internal/document-sync/user-submitted-documents`.

- [x] **Step 3: Verify API test**

Run:

```powershell
npm --workspace apps/core test -- tests/answer-draft-api.test.ts
```

Expected: API tests pass.

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

Commit docs and implementation, then push `codex/iris-document-source-registry`.

- [x] **Step 3: Update PR body and inspect PR state**

Append Phase 3I summary and verify PR #3 remains open and non-draft.
