# Iris External Error Message Budget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bound external service error messages before they are included in Iris exceptions.

**Architecture:** Add a shared `readExternalErrorMessage` helper and replace local provider/Feishu
`readErrorMessage` copies with it.

**Tech Stack:** TypeScript, Vitest, existing external adapter tests.

---

### Task 1: Write Failing Helper Tests

**Files:**
- Create: `apps/core/tests/external-error-message.test.ts`

- [x] **Step 1: Read common external error shapes**

Test nested `error.message`, top-level `msg`, and top-level `message`.

- [x] **Step 2: Test fallback behavior**

Assert blank, missing, or non-object responses return `unknown error`.

- [x] **Step 3: Test truncation**

Assert oversized external messages are at most `512` characters, contain `[truncated]`, and omit
the trailing detail.

- [x] **Step 4: Run helper test and confirm RED**

Run:

```powershell
npm --workspace apps/core test -- external-error-message.test.ts
```

Expected: the suite fails because the helper module does not exist.

Observed: the suite failed to load `../src/integrations/external-error-message.js`.

### Task 2: Implement and Wire Helper

**Files:**
- Create: `apps/core/src/integrations/external-error-message.ts`
- Modify: `apps/core/src/model/openai-compatible-model-provider.ts`
- Modify: `apps/core/src/model/openai-compatible-embedding-provider.ts`
- Modify: `apps/core/src/documents/feishu-document-body-fetcher.ts`
- Modify: `apps/core/src/feishu/feishu-tenant-access-token-provider.ts`
- Modify: `apps/core/src/permissions/feishu-document-permission-checker.ts`

- [x] **Step 1: Add helper**

Implement `readExternalErrorMessage` with nested OpenAI-compatible and top-level Feishu-style
message support, `unknown error` fallback, and `512` character truncation.

- [x] **Step 2: Replace local readers**

Import the helper in affected adapters and remove local `readErrorMessage` copies.

- [x] **Step 3: Run focused tests and confirm GREEN**

Run:

```powershell
npm --workspace apps/core test -- external-error-message.test.ts
npm --workspace apps/core test -- openai-compatible-model-provider.test.ts openai-compatible-embedding-provider.test.ts feishu-document-body-fetcher.test.ts feishu-tenant-access-token-provider.test.ts feishu-document-permission-checker.test.ts
```

Expected: helper tests and affected adapter tests pass.

Observed: helper tests passed with `4` tests, and affected adapter tests passed with `57` tests.

### Task 3: Full Verification and Publication

**Files:**
- Create: `docs/superpowers/specs/2026-07-04-iris-external-error-message-budget-design.md`
- Create: `docs/superpowers/plans/2026-07-04-iris-external-error-message-budget.md`

- [x] **Step 1: Run full verification**

Run:

```powershell
npm run verify
```

Expected: the command exits 0.

Observed: `npm run verify` exited 0 with Core `767` passed / `4` skipped, Python `7` passed, and
`docker compose config` succeeded.

- [x] **Step 2: Commit, push, and verify PR checks**

Commit the external error message budget helper, push `codex/iris-document-source-registry`,
update PR #3, and confirm GitHub Actions Core and AI Worker checks pass.

Observed: committed `4a9a33b`, pushed to `codex/iris-document-source-registry`, updated PR #3, and
confirmed GitHub Actions Core and AI Worker checks passed.
