# Iris Embedding Provider Text Budget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enforce a provider-level per-text embedding input budget before external requests.

**Architecture:** Add a `4000` character text-item guard inside the OpenAI-compatible embedding
provider, aligned with answer-time retrieval query text.

**Tech Stack:** TypeScript, Vitest, existing embedding provider tests.

---

### Task 1: Write Failing Test

**Files:**
- Modify: `apps/core/tests/openai-compatible-embedding-provider.test.ts`

- [x] **Step 1: Add oversized embedding text test**

Call `embedTexts` directly with one `4001` character text and assert it rejects before `fetch`.

- [x] **Step 2: Run focused test and confirm RED**

Run:

```powershell
npm -w apps/core test -- openai-compatible-embedding-provider.test.ts
```

Expected: the new test fails because the provider currently sends the oversized text.

Observed: the focused test failed because the provider resolved with the mocked vector, proving the
oversized text reached the external request path.

### Task 2: Implement Provider Text Budget

**Files:**
- Modify: `apps/core/src/model/openai-compatible-embedding-provider.ts`

- [x] **Step 1: Add text length constant**

Add a `4000` character maximum for each embedding input text.

- [x] **Step 2: Reject oversized text before fetch**

Validate all texts after the existing empty-input and batch-size guards, before timeout/fetch setup.

- [x] **Step 3: Run focused test and confirm GREEN**

Run:

```powershell
npm -w apps/core test -- openai-compatible-embedding-provider.test.ts
```

Expected: embedding provider tests pass.

Observed: focused embedding provider tests passed with `13` tests.

### Task 3: Full Verification and Publication

**Files:**
- Create: `docs/superpowers/specs/2026-07-04-iris-embedding-provider-text-budget-design.md`
- Create: `docs/superpowers/plans/2026-07-04-iris-embedding-provider-text-budget.md`

- [x] **Step 1: Run full verification**

Run:

```powershell
npm run verify
```

Expected: the command exits 0.

Observed: `npm run verify` exited 0 with Core `797` passed / `4` skipped, Python `7` passed, and
`docker compose config` succeeded.

- [x] **Step 2: Commit, push, and verify PR checks**

Commit the provider text budget patch, push `codex/iris-document-source-registry`, update PR #3,
and confirm GitHub Actions Core and AI Worker checks pass.

Observed: committed `b040699`, pushed to `codex/iris-document-source-registry`, updated PR #3,
and confirmed GitHub Actions Core and AI Worker checks passed.
