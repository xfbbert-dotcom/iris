# Iris Embedding Provider Batch Budget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enforce a provider-level embedding input batch budget before external requests.

**Architecture:** Mirror the document semantic indexer default `64` text batch size inside the
OpenAI-compatible embedding provider.

**Tech Stack:** TypeScript, Vitest, existing embedding provider tests.

---

### Task 1: Write Failing Test

**Files:**
- Modify: `apps/core/tests/openai-compatible-embedding-provider.test.ts`

- [x] **Step 1: Add oversized embedding batch test**

Call `embedTexts` directly with `65` texts and assert it rejects before `fetch`.

- [x] **Step 2: Run focused test and confirm RED**

Run:

```powershell
npm -w apps/core test -- openai-compatible-embedding-provider.test.ts
```

Expected: the new test fails because the provider currently sends the request.

Observed: the focused test failed with `embedding response count mismatch`, proving the oversized
batch reached the mocked external request path.

### Task 2: Implement Provider Batch Budget

**Files:**
- Modify: `apps/core/src/model/openai-compatible-embedding-provider.ts`

- [x] **Step 1: Add provider batch constant**

Add a `64` text maximum for a single embedding request.

- [x] **Step 2: Reject oversized batches before fetch**

Validate `texts.length` after the existing empty-input fast path and before timeout/fetch setup.

- [x] **Step 3: Run focused test and confirm GREEN**

Run:

```powershell
npm -w apps/core test -- openai-compatible-embedding-provider.test.ts
```

Expected: embedding provider tests pass.

Observed: focused embedding provider tests passed with `12` tests.

### Task 3: Full Verification and Publication

**Files:**
- Create: `docs/superpowers/specs/2026-07-04-iris-embedding-provider-batch-budget-design.md`
- Create: `docs/superpowers/plans/2026-07-04-iris-embedding-provider-batch-budget.md`

- [x] **Step 1: Run full verification**

Run:

```powershell
npm run verify
```

Expected: the command exits 0.

Observed: `npm run verify` exited 0 with Core `794` passed / `4` skipped, Python `7` passed, and
`docker compose config` succeeded.

- [ ] **Step 2: Commit, push, and verify PR checks**

Commit the provider batch budget patch, push `codex/iris-document-source-registry`, update PR #3,
and confirm GitHub Actions Core and AI Worker checks pass.

Observed: pending.
