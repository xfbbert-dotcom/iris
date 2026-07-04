# Iris Internal API Token Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this
> plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an optional Bearer token guard for `/internal/*` routes.

**Architecture:** Add an app-level pre-handler guard controlled by `IRIS_INTERNAL_API_TOKEN` or an
injected test dependency. Leave `/health` and `/feishu/events` unchanged.

**Tech Stack:** TypeScript, Fastify app injection tests, Vitest.

---

### Task 1: Failing Auth Tests

**Files:**
- Modify: `apps/core/tests/answer-draft-api.test.ts`

- [x] **Step 1: Add failing token guard tests**

Assert unauthenticated and wrong-token `/internal/status` requests return 401 when a token is
configured, while the correct token succeeds and `/health` remains public.

- [x] **Step 2: Verify RED**

Run the focused API test and confirm internal requests are still allowed without the token.

### Task 2: App Guard

**Files:**
- Modify: `apps/core/src/app.ts`

- [x] **Step 1: Implement pre-handler guard**

Add optional token configuration, internal route prefix detection, and Bearer-token validation.

- [x] **Step 2: Verify GREEN**

Run the focused API test and typecheck.

### Task 3: Documentation And Full Verification

**Files:**
- Modify: `docs/operations/internal-rollout-runbook.md`
- Modify: `docs/superpowers/specs/2026-06-30-iris-architecture-whitepaper.md`

- [x] **Step 1: Update docs**

Document `IRIS_INTERNAL_API_TOKEN` and the internal API security invariant.

- [x] **Step 2: Run full verification**

Run:

```powershell
npm run typecheck
npm test
python -m pytest
docker compose config
```

- [ ] **Step 3: Commit, push, and verify PR checks**

Commit the implementation, push `codex/iris-document-source-registry`, update PR #3, and confirm
GitHub Actions returns Core and AI Worker success.
