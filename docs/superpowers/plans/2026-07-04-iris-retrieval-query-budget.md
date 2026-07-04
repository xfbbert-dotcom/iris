# Iris Retrieval Query Budget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enforce the retrieval query length budget at the document retrieval context boundary.

**Architecture:** Mirror the answer-draft `4000` character question budget inside
`DocumentRetrievalContextBuilder` before embedding and vector search.

**Tech Stack:** TypeScript, Vitest, existing document retrieval context tests.

---

### Task 1: Write Failing Test

**Files:**
- Modify: `apps/core/tests/document-retrieval-context.test.ts`

- [x] **Step 1: Add oversized query text test**

Call the retrieval context builder directly with oversized `queryText` and assert it rejects before
embedding or vector search.

- [x] **Step 2: Run focused test and confirm RED**

Run:

```powershell
npm -w apps/core test -- document-retrieval-context.test.ts
```

Expected: the new test fails because the builder currently sends oversized queries through.

Observed: the focused test failed because the promise resolved instead of rejecting, proving the
direct retrieval boundary was missing.

### Task 2: Implement Retrieval Query Budget

**Files:**
- Modify: `apps/core/src/memory/document-retrieval-context.ts`

- [x] **Step 1: Add query length constant**

Set the direct retrieval query budget to `4000` characters, matching the answer-draft question
limit.

- [x] **Step 2: Reject oversized query text before embedding**

Validate at the start of `buildContext` and pass the sanitized query into `embedQuery`.

- [x] **Step 3: Run focused test and confirm GREEN**

Run:

```powershell
npm -w apps/core test -- document-retrieval-context.test.ts
```

Expected: document retrieval context tests pass.

Observed: focused document retrieval context tests passed with `13` tests.

### Task 3: Full Verification and Publication

**Files:**
- Create: `docs/superpowers/specs/2026-07-04-iris-retrieval-query-budget-design.md`
- Create: `docs/superpowers/plans/2026-07-04-iris-retrieval-query-budget.md`

- [x] **Step 1: Run full verification**

Run:

```powershell
npm run verify
```

Expected: the command exits 0.

Observed: `npm run verify` exited 0 with Core `793` passed / `4` skipped, Python `7` passed, and
`docker compose config` succeeded.

- [ ] **Step 2: Commit, push, and verify PR checks**

Commit the retrieval query budget patch, push `codex/iris-document-source-registry`, update PR #3,
and confirm GitHub Actions Core and AI Worker checks pass.

Observed: pending.
