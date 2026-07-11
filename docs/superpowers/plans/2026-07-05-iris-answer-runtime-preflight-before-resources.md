# Iris Answer Runtime Preflight Before Resources Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent answer-draft source-policy startup config failures from opening Postgres resources.

**Architecture:** Move optional Feishu live-permission checker construction before Postgres pool
creation when source-policy mode is active. Keep allow-indexed and missing-Feishu-config behavior
unchanged.

**Tech Stack:** TypeScript, Vitest, existing answer-draft runtime tests.

---

### Task 1: Write Failing Answer Runtime Preflight Test

**Files:**
- Modify: `apps/core/tests/answer-draft-runtime.test.ts`

- [x] **Step 1: Add partial Feishu config preflight test**

Add a test that enables answer drafts in `source-policy` mode with `FEISHU_APP_ID` but without
`FEISHU_APP_SECRET`. Assert `createAnswerDraftRuntime()` throws `FEISHU_APP_SECRET is required`
and `createPostgresPool` is not called.

- [x] **Step 2: Run focused test and confirm RED**

Run:

```powershell
npm --workspace apps/core test -- answer-draft-runtime.test.ts -t "answer live permission config before opening resources"
```

Observed RED: the test failed because `createPostgresPool` was called before the Feishu config
exception was thrown.

### Task 2: Move Source-Policy Feishu Preflight

**Files:**
- Modify: `apps/core/src/runtime/answer-draft-runtime.ts`

- [x] **Step 1: Move optional checker construction before pool creation**

Create `livePermissionChecker` before `createPostgresPool()` when permission mode is
`source-policy`. Leave the checker undefined in `allow-indexed` mode.

- [x] **Step 2: Run focused test and confirm GREEN**

Run:

```powershell
npm --workspace apps/core test -- answer-draft-runtime.test.ts -t "answer live permission config before opening resources"
```

Observed GREEN: 1 test passed, 15 skipped.

### Task 3: Verify and Publish

**Files:**
- Create: `docs/superpowers/specs/2026-07-05-iris-answer-runtime-preflight-before-resources-design.md`
- Create: `docs/superpowers/plans/2026-07-05-iris-answer-runtime-preflight-before-resources.md`

- [x] **Step 1: Run answer runtime tests**

Run:

```powershell
npm --workspace apps/core test -- answer-draft-runtime.test.ts answer-draft-api.test.ts
```

Observed: answer runtime and app startup tests passed with 170 tests.

- [x] **Step 2: Run full verification**

Run:

```powershell
npm run verify
```

Expected: all repository verification passes.

Observed: `npm run verify` passed. Core reported 65 test files passed with 1012 tests passed
and 4 skipped; Python worker reported 7 tests passed; Docker Compose config rendered
successfully.

- [x] **Step 3: Commit, push, update PR, and verify checks**

Commit the answer runtime preflight fix, push `codex/iris-document-source-registry`, update PR #3,
and confirm GitHub Actions Core and AI Worker checks pass.

Observed: committed as `bbf9970`, pushed to PR #3, updated the PR body, and confirmed GitHub
Actions `Core` and `AI Worker` checks passed.
