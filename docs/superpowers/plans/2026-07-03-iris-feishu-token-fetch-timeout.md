# Iris Feishu Token Fetch Timeout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent document sync workers from hanging while waiting for Feishu tenant access token requests.

**Architecture:** Add local timeout handling inside `FeishuTenantAccessTokenProvider` and pass the document sync fetch timeout from runtime composition into the token provider. Preserve token caching and existing error parsing.

**Tech Stack:** TypeScript, Vitest, Node `AbortController`, existing document sync runtime config.

---

### Task 1: Tenant Token Provider Timeout

**Files:**
- Modify: `apps/core/tests/feishu-tenant-access-token-provider.test.ts`
- Modify: `apps/core/src/feishu/feishu-tenant-access-token-provider.ts`

- [ ] **Step 1: Write failing tests**

Add a timeout test that requires tenant-token fetches to receive `AbortSignal` and map `AbortError` to `Feishu tenant access token request timed out`. Update the existing happy-path request assertion so it continues to require method, headers, body, and now signal.

- [ ] **Step 2: Verify RED**

Run: `npm --workspace apps/core test -- tests/feishu-tenant-access-token-provider.test.ts`

Expected: timeout test fails because the provider does not pass a signal or map abort errors.

- [ ] **Step 3: Implement minimal timeout support**

Add optional `timeoutMs` with a `10000` default, wrap the token `fetch` with `AbortController`, clear the timer in `finally`, and map `AbortError` to the stable timeout error.

- [ ] **Step 4: Verify GREEN**

Run: `npm --workspace apps/core test -- tests/feishu-tenant-access-token-provider.test.ts`

Expected: tenant token provider tests pass.

### Task 2: Runtime Wiring

**Files:**
- Modify: `apps/core/tests/document-sync-runtime.test.ts`
- Modify: `apps/core/src/runtime/document-sync-runtime.ts`

- [ ] **Step 1: Write failing runtime test**

Assert `createFeishuTenantAccessTokenProvider` receives `timeoutMs: 7000` from the enabled runtime fixture.

- [ ] **Step 2: Verify RED**

Run: `npm --workspace apps/core test -- tests/document-sync-runtime.test.ts`

Expected: runtime test fails because the timeout is not passed to the token provider yet.

- [ ] **Step 3: Implement runtime wiring**

Add `timeoutMs` to the token provider dependency type in `document-sync-runtime.ts` and pass `feishuConfig.documentFetchTimeoutMs`.

- [ ] **Step 4: Verify GREEN**

Run: `npm --workspace apps/core test -- tests/document-sync-runtime.test.ts`

Expected: runtime composition test passes.

### Task 3: Full Verification and Publish

**Files:**
- Modify: `docs/superpowers/specs/2026-06-30-iris-architecture-whitepaper.md`

- [ ] **Step 1: Update whitepaper guardrail**

Clarify that Feishu document sync token acquisition is also external I/O and must be bounded by timeout.

- [ ] **Step 2: Run full verification**

Run:

```powershell
npm run typecheck
python -m pytest
docker compose config
npm test
```

Expected: all commands exit successfully.

- [ ] **Step 3: Commit, push, and update PR**

Run:

```powershell
git add apps/core/src apps/core/tests docs/superpowers
git commit -m "fix: time out Feishu token fetches"
git push --force-with-lease origin codex/iris-document-source-registry
```

Expected: PR #3 points to the new commit and the PR body mentions Feishu token fetch timeouts.
