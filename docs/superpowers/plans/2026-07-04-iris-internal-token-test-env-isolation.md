# Iris Internal Token Test Env Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this
> plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent ambient `IRIS_INTERNAL_API_TOKEN` values from changing API test behavior.

**Architecture:** Reproduce the failure with an ambient token, add a tiny environment isolation
helper for tests, wire it into `buildApp()` API test files, and verify both focused and full suites.

**Tech Stack:** TypeScript, Vitest, Fastify app injection tests.

---

### Task 1: Reproduce Ambient Token Failure

**Files:**
- Test: `apps/core/tests/answer-draft-api.test.ts`

- [x] **Step 1: Run a focused test with ambient token**

Run:

```powershell
$env:IRIS_INTERNAL_API_TOKEN='ambient-secret'
npm test --workspace apps/core -- answer-draft-api.test.ts -t "returns 503 when no orchestrator"
Remove-Item Env:\IRIS_INTERNAL_API_TOKEN
```

Expected: the focused test fails with `expected 401 to be 503`.

### Task 2: Add Test Environment Isolation

**Files:**
- Create: `apps/core/tests/test-env.ts`
- Modify: `apps/core/tests/answer-draft-api.test.ts`
- Modify: `apps/core/tests/feishu-gateway.test.ts`
- Modify: `apps/core/tests/runtime-control-api.test.ts`

- [x] **Step 1: Add helper**

Create `isolateEnvVar(name)` to snapshot, delete, and restore an environment variable.

- [x] **Step 2: Isolate internal token in API tests**

Use `beforeEach` and `afterEach` to isolate `IRIS_INTERNAL_API_TOKEN` in every API test file that
constructs `buildApp()`.

- [x] **Step 3: Verify focused recovery**

Run the same focused test with ambient `IRIS_INTERNAL_API_TOKEN` and confirm it passes.

- [x] **Step 4: Verify API files under ambient token**

Run:

```powershell
$env:IRIS_INTERNAL_API_TOKEN='ambient-secret'
npm test --workspace apps/core -- answer-draft-api.test.ts feishu-gateway.test.ts runtime-control-api.test.ts
Remove-Item Env:\IRIS_INTERNAL_API_TOKEN
```

Expected: all three API test files pass.

### Task 3: Full Verification

**Files:**
- Create: `docs/superpowers/specs/2026-07-04-iris-internal-token-test-env-isolation-design.md`
- Create: `docs/superpowers/plans/2026-07-04-iris-internal-token-test-env-isolation.md`

- [x] **Step 1: Run full verification**

Run:

```powershell
npm run verify
```

Expected: the command exits 0.

- [ ] **Step 2: Commit, push, and verify PR checks**

Commit the test isolation change, push `codex/iris-document-source-registry`, update PR #3, and
confirm GitHub Actions returns Core and AI Worker success.
