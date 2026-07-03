# Iris Feishu Document Fetch Timeout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent Feishu document sync workers from hanging on stalled wiki-node or raw-content fetches.

**Architecture:** Add a small timeout wrapper inside the Feishu document body fetcher and thread a configurable timeout through environment/runtime composition. Keep retry/dead-letter behavior unchanged.

**Tech Stack:** TypeScript, Vitest, Node `AbortController`, existing env parsing helpers.

---

### Task 1: Fetcher Timeout Behavior

**Files:**
- Modify: `apps/core/tests/feishu-document-body-fetcher.test.ts`
- Modify: `apps/core/src/documents/feishu-document-body-fetcher.ts`

- [ ] **Step 1: Write failing tests**

Add tests proving raw-content and wiki-node requests abort and produce stable timeout errors.

- [ ] **Step 2: Verify RED**

Run: `npm --workspace apps/core test -- tests/feishu-document-body-fetcher.test.ts`

Expected: timeout tests fail because the fetcher does not pass a `signal` and does not map abort errors.

- [ ] **Step 3: Implement minimal fetch timeout**

Add `timeoutMs` to the fetcher dependencies, create an `AbortController` per Feishu request, pass `signal`, map `AbortError` to the operation-specific timeout message, and clear timers in `finally`.

- [ ] **Step 4: Verify GREEN**

Run: `npm --workspace apps/core test -- tests/feishu-document-body-fetcher.test.ts`

Expected: all Feishu document body fetcher tests pass.

### Task 2: Runtime Configuration Wiring

**Files:**
- Modify: `apps/core/tests/env.test.ts`
- Modify: `apps/core/tests/document-sync-runtime.test.ts`
- Modify: `apps/core/src/config/env.ts`
- Modify: `apps/core/src/runtime/document-sync-runtime.ts`

- [ ] **Step 1: Write failing tests**

Add tests proving `IRIS_FEISHU_DOCUMENT_FETCH_TIMEOUT_MS` parses as a positive integer and is passed to `createFeishuDocumentBodyFetcher`.

- [ ] **Step 2: Verify RED**

Run: `npm --workspace apps/core test -- tests/env.test.ts tests/document-sync-runtime.test.ts`

Expected: tests fail because the env field and runtime wiring do not exist yet.

- [ ] **Step 3: Implement minimal runtime wiring**

Add `documentFetchTimeoutMs` to `FeishuOpenApiConfig`, parse it with `readPositiveIntegerEnv`, pass it as `timeoutMs` when creating the Feishu document body fetcher, and update dependency typing.

- [ ] **Step 4: Verify GREEN**

Run: `npm --workspace apps/core test -- tests/env.test.ts tests/document-sync-runtime.test.ts`

Expected: config and runtime tests pass.

### Task 3: Full Verification and Publish

**Files:**
- No additional code files.

- [ ] **Step 1: Run full verification**

Run:

```powershell
npm run typecheck
python -m pytest
docker compose config
npm test
```

Expected: all commands exit successfully.

- [ ] **Step 2: Commit and push**

Run:

```powershell
git add apps/core/src apps/core/tests docs/superpowers
git commit -m "fix: time out Feishu document fetches"
git push --force-with-lease origin codex/iris-document-source-registry
```

Expected: branch pushes to PR #3.

- [ ] **Step 3: Update PR body**

Add a summary bullet noting Feishu document fetch timeouts, then verify PR #3 still points to the new head commit.
