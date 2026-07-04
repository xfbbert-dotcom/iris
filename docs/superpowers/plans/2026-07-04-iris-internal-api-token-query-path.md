# Iris Internal API Token Query Path Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this
> plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure query-bearing `/internal` requests cannot bypass the shared internal token guard.

**Architecture:** Add an API regression test for `/internal?probe=1`, then make
`isInternalApiRequest()` evaluate the path before the query string. Keep the existing Fastify
`onRequest` timing and response shape.

**Tech Stack:** TypeScript, Fastify app injection tests, Vitest.

---

### Task 1: Failing Query-Path Guard Test

**Files:**
- Modify: `apps/core/tests/answer-draft-api.test.ts`

- [x] **Step 1: Add query-bearing root probe test**

Assert that a token-protected `GET /internal?probe=1` request without `Authorization` returns:

```json
{
  "ok": false,
  "error": "internal_api_unauthorized"
}
```

- [x] **Step 2: Verify RED**

Run:

```powershell
npm test --workspace apps/core -- answer-draft-api.test.ts -t "guards internal root probes"
```

Expected: the focused test fails with `expected 404 to be 401`.

### Task 2: Normalize Internal Guard Path

**Files:**
- Modify: `apps/core/src/app.ts`

- [x] **Step 1: Strip query before matching**

Change `isInternalApiRequest(url)` so it evaluates `url.split("?", 1)[0]` and protects that path
when it is `/internal` or starts with `/internal/`.

- [x] **Step 2: Verify GREEN**

Run:

```powershell
npm test --workspace apps/core -- answer-draft-api.test.ts -t "guards internal root probes"
npm test --workspace apps/core -- answer-draft-api.test.ts -t "internal API token guard"
```

Expected: both focused runs pass.

### Task 3: Documentation And Full Verification

**Files:**
- Modify: `docs/superpowers/specs/2026-07-04-iris-internal-api-token-guard-design.md`
- Modify: `docs/superpowers/specs/2026-06-30-iris-architecture-whitepaper.md`
- Modify: `docs/operations/internal-rollout-runbook.md`

- [x] **Step 1: Record query-path invariant**

Document that the internal token boundary applies after stripping the query string from the request
URL.

- [x] **Step 2: Run full verification**

Run:

```powershell
git diff --check
npm run typecheck
npm test
Push-Location workers\ai; python -m pytest; Pop-Location
docker compose config
```

Expected: all commands exit 0.

- [ ] **Step 3: Commit, push, and verify PR checks**

Commit the implementation, push `codex/iris-document-source-registry`, update PR #3, and confirm
GitHub Actions returns Core and AI Worker success.
