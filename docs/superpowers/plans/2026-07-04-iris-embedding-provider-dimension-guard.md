# Iris Embedding Provider Dimension Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reject embedding provider vectors whose length does not match configured dimensions
before indexing or retrieval uses them.

**Architecture:** Pass `config.dimensions` into embedding response parsing and validate each vector
length when dimensions are configured.

**Tech Stack:** TypeScript, Vitest, existing OpenAI-compatible embedding provider tests.

---

### Task 1: Write Failing Test

**Files:**
- Modify: `apps/core/tests/openai-compatible-embedding-provider.test.ts`

- [x] **Step 1: Add configured-dimension mismatch test**

Create a provider with `dimensions: 3`, return one embedding vector `[1, 0]`, and expect:

```ts
"embedding vector length 2 does not match configured dimension 3"
```

- [x] **Step 2: Run focused test and confirm RED**

Run:

```powershell
npm --workspace apps/core test -- openai-compatible-embedding-provider.test.ts -t "configured dimensions"
```

Expected: the new test fails because the provider currently returns the bad vector.

Observed: focused test failed because the promise resolved with `[[1, 0]]` instead of rejecting.

### Task 2: Implement Dimension Guard

**Files:**
- Modify: `apps/core/src/model/openai-compatible-embedding-provider.ts`

- [x] **Step 1: Pass expected dimensions to parser**

Call:

```ts
readEmbeddingVectors(responseBody, config.dimensions)
```

- [x] **Step 2: Validate vector length**

After validating numeric values, reject vectors whose length differs from configured dimensions.

- [x] **Step 3: Run focused tests and confirm GREEN**

Run:

```powershell
npm --workspace apps/core test -- openai-compatible-embedding-provider.test.ts -t "configured dimensions"
npm --workspace apps/core test -- openai-compatible-embedding-provider.test.ts
```

Expected: focused test and full provider test file pass.

Observed: focused configured-dimension test passed, and the full provider test file passed with
`11` tests.

### Task 3: Full Verification and Publication

**Files:**
- Create: `docs/superpowers/specs/2026-07-04-iris-embedding-provider-dimension-guard-design.md`
- Create: `docs/superpowers/plans/2026-07-04-iris-embedding-provider-dimension-guard.md`

- [x] **Step 1: Run full verification**

Run:

```powershell
npm run verify
```

Expected: the command exits 0.

Observed: `npm run verify` exited 0 with Core `763` passed / `4` skipped, Python `7` passed, and
`docker compose config` succeeded.

- [x] **Step 2: Commit, push, and verify PR checks**

Commit the embedding provider dimension guard, push `codex/iris-document-source-registry`, update
PR #3, and confirm GitHub Actions Core and AI Worker checks pass.

Observed: committed `f054b25`, pushed to `codex/iris-document-source-registry`, updated PR #3, and
confirmed GitHub Actions Core and AI Worker checks passed.
