# Iris Internal API Token Guard Before Body Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this
> plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the internal API token guard before body parsing.

**Architecture:** Convert the token guard from `preHandler` to `onRequest` and cover invalid JSON
unauthorized requests.

**Tech Stack:** TypeScript, Fastify app injection tests, Vitest.

---

### Task 1: Failing Early-Rejection Test

**Files:**
- Modify: `apps/core/tests/answer-draft-api.test.ts`

- [x] **Step 1: Add invalid-body unauthorized test**

Assert a token-protected `/internal/*` POST with invalid JSON and no authorization returns 401.

- [x] **Step 2: Verify RED**

Run the focused API test and confirm the request currently fails before the token guard.

### Task 2: Move Guard Earlier

**Files:**
- Modify: `apps/core/src/app.ts`

- [x] **Step 1: Use `onRequest` for token guard**

Move the token guard to Fastify `onRequest` so unauthorized internal requests stop before body
parsing.

- [x] **Step 2: Verify GREEN**

Run the focused API test and typecheck.

### Task 3: Full Verification

**Files:**
- Modify: `docs/superpowers/specs/2026-07-04-iris-internal-api-token-guard-design.md`

- [x] **Step 1: Update token guard design**

Record that the guard runs before body parsing.

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
