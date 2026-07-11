# Iris External Response Body Timeout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure external HTTP timeouts cover both response headers and JSON body reads.

**Architecture:** Move JSON body parsing into each provider's timeout-protected try/finally window or use a local helper that returns `{ response, responseBody }`. Preserve existing error messages for malformed JSON and existing timeout messages for aborts.

**Tech Stack:** TypeScript, Vitest, Node `AbortController`.

---

### Task 1: RED Tests

**Files:**
- Modify: `apps/core/tests/openai-compatible-model-provider.test.ts`
- Modify: `apps/core/tests/openai-compatible-embedding-provider.test.ts`
- Modify: `apps/core/tests/feishu-tenant-access-token-provider.test.ts`
- Modify: `apps/core/tests/feishu-document-body-fetcher.test.ts`

- [ ] **Step 1: Write body abort tests**

Add tests where `fetch` resolves with a response whose `json()` throws an `AbortError`. Assert each provider reports its timeout message, not an invalid JSON message.

- [ ] **Step 2: Verify RED**

Run:

```powershell
npm --workspace apps/core test -- tests/openai-compatible-model-provider.test.ts tests/openai-compatible-embedding-provider.test.ts tests/feishu-tenant-access-token-provider.test.ts tests/feishu-document-body-fetcher.test.ts
```

Expected: body abort tests fail because aborts during `response.json()` are currently mapped to invalid JSON or are outside the timeout window.

### Task 2: Timeout Coverage

**Files:**
- Modify: `apps/core/src/model/openai-compatible-model-provider.ts`
- Modify: `apps/core/src/model/openai-compatible-embedding-provider.ts`
- Modify: `apps/core/src/feishu/feishu-tenant-access-token-provider.ts`
- Modify: `apps/core/src/documents/feishu-document-body-fetcher.ts`

- [ ] **Step 1: Extend timeout windows**

Keep timers active until JSON parsing completes. Rethrow `AbortError` from JSON helpers so outer timeout handling can map it to the provider timeout message.

- [ ] **Step 2: Verify GREEN**

Run the same focused provider test command.

Expected: all provider tests pass.

### Task 3: Full Verification and Publish

**Files:**
- Modify: `docs/superpowers/specs/2026-06-30-iris-architecture-whitepaper.md`

- [ ] **Step 1: Update whitepaper**

Clarify that external request timeouts cover response body consumption, not only header fetch.

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
git commit -m "fix: keep response body reads within request timeouts"
git push --force-with-lease origin codex/iris-document-source-registry
```

Expected: PR #3 points to the new commit and its summary mentions response body timeout coverage.
