# Iris Document Sync Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Compose the document sync queue, worker, runner, Postgres repositories, and Feishu fetcher into a disabled-by-default runtime.

**Architecture:** Add environment config first, then a runtime composer patterned after existing event/reindex runtimes. Keep queue in-memory and runtime startup/API integration out of scope.

**Tech Stack:** TypeScript, Vitest, Postgres repository factories, Feishu fetcher, document sync worker loop.

---

## File Structure

- Modify `apps/core/src/config/env.ts`
  - Add `DocumentSyncWorkerRuntimeConfig`.
  - Add `FeishuOpenApiConfig`.
  - Add readers for document sync worker and Feishu OpenAPI config.
- Modify `apps/core/tests/env.test.ts`
  - Cover disabled defaults, enabled config defaults, required Feishu credentials, invalid intervals and limits.
- Create `apps/core/src/runtime/document-sync-runtime.ts`
  - Compose pool, registries, snapshots, token provider, fetcher, queue, worker, and loop.
- Create `apps/core/tests/document-sync-runtime.test.ts`
  - Cover disabled runtime, dependency composition, status, start, and close.

## Task 1: Runtime Env Config

**Files:**
- Modify: `apps/core/src/config/env.ts`
- Modify: `apps/core/tests/env.test.ts`

- [ ] **Step 1: Write failing env tests**

Tests should assert disabled default, enabled defaults, required `FEISHU_APP_ID` and `FEISHU_APP_SECRET`, optional `FEISHU_OPEN_BASE_URL`, and invalid positive integer handling.

- [ ] **Step 2: Run env tests to verify they fail**

Run: `npm test -- env.test.ts`

Expected: FAIL because config readers do not exist.

- [ ] **Step 3: Implement env config readers**

Add:

```ts
export type DocumentSyncWorkerRuntimeConfig =
  | { enabled: false }
  | { enabled: true; intervalMs: number; batchLimit: number };

export type FeishuOpenApiConfig = {
  appId: string;
  appSecret: string;
  baseUrl: string;
};
```

Add `readDocumentSyncWorkerRuntimeConfig` and `readFeishuOpenApiConfig`.

- [ ] **Step 4: Run env tests**

Run: `npm test -- env.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/core/src/config/env.ts apps/core/tests/env.test.ts
git commit -m "feat: add document sync runtime config"
```

## Task 2: Document Sync Runtime Composer

**Files:**
- Create: `apps/core/src/runtime/document-sync-runtime.ts`
- Test: `apps/core/tests/document-sync-runtime.test.ts`

- [ ] **Step 1: Write failing runtime tests**

Tests should assert:

- runtime returns undefined when disabled;
- enabled runtime creates pool, document source registry, snapshot repository, token provider, fetcher, queue, runner, worker, and loop;
- start calls loop.start;
- getStatus returns queue pending count and loop snapshot;
- close stops loop and closes pool.

- [ ] **Step 2: Run runtime tests to verify they fail**

Run: `npm test -- document-sync-runtime.test.ts`

Expected: FAIL because runtime file does not exist.

- [ ] **Step 3: Implement runtime composer**

Default dependencies:

- `createPostgresPool`
- `createPostgresDocumentSourceRegistry`
- `createDocumentSnapshotRepository`
- `createFeishuTenantAccessTokenProvider`
- `createFeishuDocumentBodyFetcher`
- `createInMemoryDocumentSyncQueue`
- `createDocumentSyncRunner`
- `createDocumentSyncWorker`
- `createDocumentSyncWorkerLoop`

- [ ] **Step 4: Run runtime tests**

Run: `npm test -- document-sync-runtime.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/core/src/runtime/document-sync-runtime.ts apps/core/tests/document-sync-runtime.test.ts
git commit -m "feat: add document sync runtime"
```

## Task 3: Full Verification And PR Update

- [ ] **Step 1: Run TypeScript typecheck**

Run: `npm run typecheck`

Expected: exit 0.

- [ ] **Step 2: Run TypeScript tests**

Run: `npm test`

Expected: all tests pass.

- [ ] **Step 3: Run Python worker tests**

Run: `python -m pytest` from `workers/ai`

Expected: all tests pass.

- [ ] **Step 4: Run Docker Compose validation**

Run: `docker compose config`

Expected: exit 0.

- [ ] **Step 5: Push and update PR**

```bash
git push origin codex/iris-document-source-registry
gh pr edit 3 --repo xfbbert-dotcom/iris --body "<updated body with Phase 3A summary>"
```

Expected: PR #3 contains Phase 3A summary and checked test plan.

## Self-Review

- Spec coverage: config, runtime composition, status, defaults, and close lifecycle are covered.
- Placeholder scan: no incomplete placeholder markers are present.
- Type consistency: `DocumentSyncWorkerRuntimeConfig`, `FeishuOpenApiConfig`, `createDocumentSyncRuntime`, and `DocumentSyncRuntimeStatus` names are consistent.
