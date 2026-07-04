# Iris Feishu Auth Test Env Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this
> plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent ambient Feishu auth environment variables from changing Feishu gateway route test
behavior.

**Architecture:** Reproduce the failure with an ambient `FEISHU_VERIFICATION_TOKEN`, reuse the
existing environment isolation helper in Feishu gateway tests, and verify both focused and full
suites.

**Tech Stack:** TypeScript, Vitest, Fastify app injection tests.

---

### Task 1: Reproduce Ambient Feishu Auth Failure

**Files:**
- Test: `apps/core/tests/feishu-gateway.test.ts`

- [x] **Step 1: Run a focused test with ambient Feishu token**

Run:

```powershell
$oldToken = $env:FEISHU_VERIFICATION_TOKEN
$oldKey = $env:FEISHU_ENCRYPT_KEY
try {
  $env:FEISHU_VERIFICATION_TOKEN = 'ambient-token'
  Remove-Item Env:\FEISHU_ENCRYPT_KEY -ErrorAction SilentlyContinue
  npm --workspace apps/core test -- feishu-gateway.test.ts -t "returns 200 from the Feishu callback route"
} finally {
  if ($null -eq $oldToken) { Remove-Item Env:\FEISHU_VERIFICATION_TOKEN -ErrorAction SilentlyContinue } else { $env:FEISHU_VERIFICATION_TOKEN = $oldToken }
  if ($null -eq $oldKey) { Remove-Item Env:\FEISHU_ENCRYPT_KEY -ErrorAction SilentlyContinue } else { $env:FEISHU_ENCRYPT_KEY = $oldKey }
}
```

Observed: the focused test failed with `expected 401 to be 200`.

### Task 2: Add Feishu Test Environment Isolation

**Files:**
- Modify: `apps/core/tests/feishu-gateway.test.ts`

- [x] **Step 1: Isolate Feishu auth env vars in Feishu gateway tests**

Use `beforeEach` and `afterEach` to isolate `FEISHU_VERIFICATION_TOKEN` and `FEISHU_ENCRYPT_KEY`
alongside the existing `IRIS_INTERNAL_API_TOKEN` isolation.

- [x] **Step 2: Verify focused recovery**

Run the same focused test with ambient `FEISHU_VERIFICATION_TOKEN` and confirm it passes.

Observed: the focused route test passed with an ambient `FEISHU_VERIFICATION_TOKEN`.

- [x] **Step 3: Verify Feishu gateway file under ambient Feishu auth vars**

Run `feishu-gateway.test.ts` with ambient `FEISHU_VERIFICATION_TOKEN` and `FEISHU_ENCRYPT_KEY`.

Observed: all 31 tests passed.

### Task 3: Full Verification

**Files:**
- Create: `docs/superpowers/specs/2026-07-04-iris-feishu-auth-test-env-isolation-design.md`
- Create: `docs/superpowers/plans/2026-07-04-iris-feishu-auth-test-env-isolation.md`

- [x] **Step 1: Run full verification**

Run:

```powershell
npm run verify
```

Expected: the command exits 0.

Observed: `npm run verify` exited 0 with Core 750 passed / 4 skipped, Python 7 passed, and
`docker compose config` succeeded.

- [x] **Step 2: Commit, push, and verify PR checks**

Commit the test isolation change, push `codex/iris-document-source-registry`, update PR #3, and
confirm GitHub Actions returns Core and AI Worker success.

Observed: committed `62165bb`, pushed to `codex/iris-document-source-registry`, updated PR #3, and
confirmed GitHub Actions Core and AI Worker checks passed.
