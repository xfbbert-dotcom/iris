# Iris Runtime Close Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this
> plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure `app.close()` attempts every runtime close before surfacing shutdown errors.

**Architecture:** Replace the sequential Fastify `onClose` awaits with a small helper that records
the first close error, continues closing remaining runtimes, and then rethrows.

**Tech Stack:** TypeScript, Fastify app close tests, Vitest.

---

### Task 1: Failing Lifecycle Test

**Files:**
- Modify: `apps/core/tests/answer-draft-api.test.ts`

- [x] **Step 1: Add failing app close isolation test**

Inject all runtimes, make document sync close fail, assert event worker, reindex, and answer draft
close are still called, and assert `app.close()` rejects.

- [x] **Step 2: Verify RED**

Run the focused API test and confirm the later runtime close assertions fail.

### Task 2: Runtime Close Helper

**Files:**
- Modify: `apps/core/src/app.ts`

- [x] **Step 1: Implement isolated close attempts**

Add a helper used by the Fastify `onClose` hook to attempt every close operation and rethrow the
first error afterward.

- [x] **Step 2: Verify GREEN**

Run the focused API test and typecheck.

### Task 3: Documentation And Full Verification

**Files:**
- Modify: `docs/superpowers/specs/2026-06-30-iris-architecture-whitepaper.md`

- [x] **Step 1: Update whitepaper**

Record that app shutdown must attempt all runtime cleanup before surfacing close errors.

- [x] **Step 2: Run full verification**

Run:

```powershell
npm run typecheck
npm test
python -m pytest
docker compose config
```

- [x] **Step 3: Commit, push, and verify PR checks**

Commit the implementation, push `codex/iris-document-source-registry`, update PR #3, and confirm
GitHub Actions returns Core and AI Worker success.
