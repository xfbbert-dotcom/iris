# Iris Model Provider Request Budget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enforce model request input budgets inside the OpenAI-compatible model provider.

**Architecture:** Add provider-level question and prompt-context length guards before external
chat-completions requests.

**Tech Stack:** TypeScript, Vitest, existing model provider tests.

---

### Task 1: Write Failing Tests

**Files:**
- Modify: `apps/core/tests/openai-compatible-model-provider.test.ts`

- [x] **Step 1: Add oversized question test**

Call `generateAnswerDraft` directly with a `4001` character question and assert it rejects before
`fetch`.

- [x] **Step 2: Add oversized prompt context test**

Call `generateAnswerDraft` directly with an `80001` character prompt context and assert it rejects
before `fetch`.

- [x] **Step 3: Run focused test and confirm RED**

Run:

```powershell
npm -w apps/core test -- openai-compatible-model-provider.test.ts
```

Expected: the new tests fail because the provider currently sends oversized requests.

Observed: both focused tests failed because the provider resolved with the mocked answer, proving
oversized question and prompt context inputs reached the external request path.

### Task 2: Implement Model Request Budgets

**Files:**
- Modify: `apps/core/src/model/openai-compatible-model-provider.ts`

- [x] **Step 1: Add provider request constants**

Add `4000` character question and `80000` character prompt-context maximums.

- [x] **Step 2: Reject oversized model inputs before fetch**

Validate both fields at the start of `generateAnswerDraft`, before timeout and fetch setup.

- [x] **Step 3: Run focused test and confirm GREEN**

Run:

```powershell
npm -w apps/core test -- openai-compatible-model-provider.test.ts
```

Expected: model provider tests pass.

Observed: focused model provider tests passed with `10` tests.

### Task 3: Full Verification and Publication

**Files:**
- Create: `docs/superpowers/specs/2026-07-04-iris-model-provider-request-budget-design.md`
- Create: `docs/superpowers/plans/2026-07-04-iris-model-provider-request-budget.md`

- [x] **Step 1: Run full verification**

Run:

```powershell
npm run verify
```

Expected: the command exits 0.

Observed: `npm run verify` exited 0 with Core `796` passed / `4` skipped, Python `7` passed, and
`docker compose config` succeeded.

- [x] **Step 2: Commit, push, and verify PR checks**

Commit the model provider request budget patch, push `codex/iris-document-source-registry`, update
PR #3, and confirm GitHub Actions Core and AI Worker checks pass.

Observed: committed `29cf7c8`, pushed to `codex/iris-document-source-registry`, updated PR #3,
and confirmed GitHub Actions Core and AI Worker checks passed.
