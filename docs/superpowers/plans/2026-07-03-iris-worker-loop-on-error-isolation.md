# Iris Worker Loop onError Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent observability hook failures from breaking Iris worker loops.

**Architecture:** Add a tiny local `reportError` helper to each worker loop that calls `onError` inside its own `try/catch`. Keep batch snapshot behavior and scheduling unchanged.

**Tech Stack:** TypeScript, Vitest fake timers.

---

### Task 1: RED Tests

**Files:**
- Modify: `apps/core/tests/raw-event-worker-loop.test.ts`
- Modify: `apps/core/tests/document-sync-worker-loop.test.ts`
- Modify: `apps/core/tests/document-reindex-worker-loop.test.ts`

- [ ] **Step 1: Write tests for throwing onError hooks**

In each loop test file, configure `worker.processBatch` to reject once and then resolve. Configure `onError` to throw. Assert the first timer run resolves, the failed snapshot is recorded, and advancing the timer runs the second batch.

- [ ] **Step 2: Verify RED**

Run:

```powershell
npm --workspace apps/core test -- tests/raw-event-worker-loop.test.ts tests/document-sync-worker-loop.test.ts tests/document-reindex-worker-loop.test.ts
```

Expected: the new tests fail because `onError` exceptions currently escape the loop tick.

### Task 2: Implementation

**Files:**
- Modify: `apps/core/src/events/raw-event-worker-loop.ts`
- Modify: `apps/core/src/documents/document-sync-worker-loop.ts`
- Modify: `apps/core/src/reindex/document-reindex-worker-loop.ts`

- [ ] **Step 1: Isolate onError**

Replace direct `onError?.(error)` calls with a helper that catches and ignores hook errors.

- [ ] **Step 2: Verify GREEN**

Run the same focused worker-loop test command.

Expected: all worker-loop tests pass.

### Task 3: Full Verification and Publish

**Files:**
- Modify: `docs/superpowers/specs/2026-06-30-iris-architecture-whitepaper.md`

- [ ] **Step 1: Update whitepaper**

Add a worker lifecycle guardrail that observability hooks must not break worker polling.

- [ ] **Step 2: Run full verification**

Run:

```powershell
npm run typecheck
python -m pytest
docker compose config
npm test
```

Expected: all commands exit successfully.

- [ ] **Step 3: Commit, push, and update PR**

Run:

```powershell
git add apps/core/src apps/core/tests docs/superpowers
git commit -m "fix: isolate worker loop error hooks"
git push --force-with-lease origin codex/iris-document-source-registry
```

Expected: PR #3 points to the new commit and its summary mentions worker loop error hook isolation.
