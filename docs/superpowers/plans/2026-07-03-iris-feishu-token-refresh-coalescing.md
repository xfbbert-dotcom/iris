# Iris Feishu Token Refresh Coalescing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent concurrent Iris callers from issuing duplicate Feishu tenant access token refresh requests.

**Architecture:** Keep token caching inside the TypeScript Core provider and add one process-local in-flight refresh promise. Successful refreshes update the existing cache; failed refreshes clear the in-flight state and leave retries possible.

**Tech Stack:** TypeScript, Vitest, Feishu HTTP API adapter.

---

## File Map

- Modify: `apps/core/tests/feishu-tenant-access-token-provider.test.ts`
  - Adds RED coverage for concurrent refresh sharing and failed-refresh cleanup.
- Modify: `apps/core/src/feishu/feishu-tenant-access-token-provider.ts`
  - Adds in-flight promise coalescing around the token fetch path.
- Modify: `docs/superpowers/specs/2026-06-30-iris-architecture-whitepaper.md`
  - Adds the Feishu token refresh stampede pressure test.

### Task 1: RED Coverage

**Files:**
- Modify: `apps/core/tests/feishu-tenant-access-token-provider.test.ts`

- [x] **Step 1: Add concurrent refresh sharing test**

Create two `getTenantAccessToken()` calls before the mocked fetch resolves. Assert the fetch is called once, both promises resolve to the same token, and a later cached call does not fetch again.

- [x] **Step 2: Add failed-refresh cleanup test**

Mock the first fetch to reject and the second fetch to succeed. Call `getTenantAccessToken()` concurrently twice, assert one failed fetch, then assert a later call retries and succeeds.

- [x] **Step 3: Verify RED**

Run:

```powershell
npm --workspace apps/core test -- tests/feishu-tenant-access-token-provider.test.ts
```

Expected before implementation: FAIL because the provider calls `fetch` once per concurrent caller.

### Task 2: Implement In-Flight Coalescing

**Files:**
- Modify: `apps/core/src/feishu/feishu-tenant-access-token-provider.ts`

- [x] **Step 1: Add process-local in-flight state**

Add `let inFlightTokenRequest: Promise<string> | undefined` next to the existing cached token.

- [x] **Step 2: Share the in-flight promise**

After checking the completed cache, return `inFlightTokenRequest` when it exists.

- [x] **Step 3: Extract refresh logic**

Move the existing fetch, timeout, response parsing, and cache write into a helper invoked once per refresh.

- [x] **Step 4: Clear in-flight state on settle**

Use `try/finally` around `await inFlightTokenRequest` so failed and successful refreshes both release the in-flight slot.

- [x] **Step 5: Verify GREEN**

Run:

```powershell
npm --workspace apps/core test -- tests/feishu-tenant-access-token-provider.test.ts
```

Expected after implementation: 8 tests pass.

### Task 3: Full Verification And Commit

**Files:**
- Create: `docs/superpowers/specs/2026-07-03-iris-feishu-token-refresh-coalescing-design.md`
- Create: `docs/superpowers/plans/2026-07-03-iris-feishu-token-refresh-coalescing.md`
- Modify: `docs/superpowers/specs/2026-06-30-iris-architecture-whitepaper.md`

- [x] **Step 1: Run full verification**

Run:

```powershell
npm run typecheck
python -m pytest
docker compose config
npm test
```

Expected: all commands exit 0.

- [x] **Step 2: Commit, push, and update PR**

Run:

```powershell
git add apps/core/src/feishu/feishu-tenant-access-token-provider.ts apps/core/tests/feishu-tenant-access-token-provider.test.ts docs/superpowers/specs/2026-06-30-iris-architecture-whitepaper.md docs/superpowers/specs/2026-07-03-iris-feishu-token-refresh-coalescing-design.md docs/superpowers/plans/2026-07-03-iris-feishu-token-refresh-coalescing.md
git commit -m "fix: coalesce Feishu tenant token refreshes"
git push origin codex/iris-document-source-registry
```
