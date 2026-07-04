# Iris Internal API Token Bearer Case Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this
> plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Accept standard bearer authorization scheme casing variants for internal operator APIs.

**Architecture:** Add a focused API regression test for lower-case `bearer`, then parse the
authorization header with a case-insensitive bearer scheme while keeping the token value exact.

**Tech Stack:** TypeScript, Fastify app injection tests, Vitest.

---

### Task 1: Failing Bearer Case Test

**Files:**
- Modify: `apps/core/tests/answer-draft-api.test.ts`

- [x] **Step 1: Add lower-case bearer test**

Assert that `GET /internal/status` with `Authorization: bearer operator-secret` returns 200 when
the configured internal token is `operator-secret`.

- [x] **Step 2: Verify RED**

Run:

```powershell
npm test --workspace apps/core -- answer-draft-api.test.ts -t "accepts bearer authorization scheme"
```

Expected: the focused test fails with `expected 401 to be 200`.

### Task 2: Parse Bearer Scheme Case-Insensitively

**Files:**
- Modify: `apps/core/src/app.ts`

- [x] **Step 1: Add authorization helper**

Replace the exact header string comparison with a helper that matches `/^Bearer\s+(.+)$/i` and
compares the captured token exactly with the configured shared secret.

- [x] **Step 2: Verify GREEN**

Run:

```powershell
npm test --workspace apps/core -- answer-draft-api.test.ts -t "accepts bearer authorization scheme"
npm test --workspace apps/core -- answer-draft-api.test.ts -t "internal API token guard"
```

Expected: both focused runs pass.

### Task 3: Documentation And Full Verification

**Files:**
- Modify: `docs/superpowers/specs/2026-07-04-iris-internal-api-token-guard-design.md`
- Modify: `docs/superpowers/specs/2026-06-30-iris-architecture-whitepaper.md`
- Modify: `docs/operations/internal-rollout-runbook.md`

- [x] **Step 1: Record bearer casing invariant**

Document that the bearer scheme is case-insensitive and the token value remains exact.

- [x] **Step 2: Run full verification**

Run:

```powershell
npm run verify
```

Expected: the command exits 0.

- [x] **Step 3: Commit, push, and verify PR checks**

Commit the implementation, push `codex/iris-document-source-registry`, update PR #3, and confirm
GitHub Actions returns Core and AI Worker success.
