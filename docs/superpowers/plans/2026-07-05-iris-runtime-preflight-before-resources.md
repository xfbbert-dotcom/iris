# Iris Runtime Preflight Before Resources Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make startup configuration failures occur before event/document-sync runtimes open
Postgres or Redis resources.

**Architecture:** Move synchronous optional integration validation ahead of resource construction.
Keep runtime composition and status behavior unchanged after validation succeeds.

**Tech Stack:** TypeScript, Vitest, existing runtime factory unit tests.

---

### Task 1: Write Failing Preflight Tests

**Files:**
- Modify: `apps/core/tests/event-worker-runtime.test.ts`
- Modify: `apps/core/tests/document-sync-runtime.test.ts`

- [x] **Step 1: Add event worker partial Feishu config test**

Add a test that enables the event worker and mention replies with `IRIS_FEISHU_BOT_OPEN_ID` plus
`FEISHU_APP_ID`, but omits `FEISHU_APP_SECRET`. Assert `createEventWorkerRuntime()` throws
`FEISHU_APP_SECRET is required` and that `createPostgresPool` / `createRedisClient` are not called.

- [x] **Step 2: Add document sync missing embedding dimensions test**

Add a test that enables document sync and configures an embedding provider without
`IRIS_EMBEDDING_DIMENSIONS`. Assert `createDocumentSyncRuntime()` throws
`IRIS_EMBEDDING_DIMENSIONS is required when document sync reindex enqueue is enabled` and that
`createPostgresPool` / `createRedisClient` are not called.

- [x] **Step 3: Run focused tests and confirm RED**

Run:

```powershell
npm --workspace apps/core test -- event-worker-runtime.test.ts document-sync-runtime.test.ts -t "before opening resources"
```

Observed RED: both tests failed because `createPostgresPool` was called before the configuration
exception was thrown.

### Task 2: Move Runtime Preflight Ahead of Resources

**Files:**
- Modify: `apps/core/src/runtime/event-worker-runtime.ts`
- Modify: `apps/core/src/runtime/document-sync-runtime.ts`

- [x] **Step 1: Preflight event mention readiness**

Compute mention-answer readiness before creating Postgres/Redis resources. Reuse the existing
`createOptionalMentionAnswerResponder()` logic so partial Feishu config still throws and missing
optional setup still becomes an unavailable reason.

- [x] **Step 2: Preflight document sync embedding config**

Read and validate the optional embedding provider config before creating Postgres/Redis resources.
Pass the validated config into `createSyncedSnapshotReindexer()`.

- [x] **Step 3: Run focused tests and confirm GREEN**

Run:

```powershell
npm --workspace apps/core test -- event-worker-runtime.test.ts document-sync-runtime.test.ts -t "before opening resources"
```

Observed GREEN: 2 tests passed, 6 skipped.

### Task 3: Verify and Publish

**Files:**
- Create: `docs/superpowers/specs/2026-07-05-iris-runtime-preflight-before-resources-design.md`
- Create: `docs/superpowers/plans/2026-07-05-iris-runtime-preflight-before-resources.md`

- [x] **Step 1: Run runtime tests**

Run:

```powershell
npm --workspace apps/core test -- event-worker-runtime.test.ts document-sync-runtime.test.ts answer-draft-api.test.ts
```

Observed: event worker runtime, document sync runtime, and app startup tests passed with 162 tests.

- [x] **Step 2: Run full verification**

Run:

```powershell
npm run verify
```

Observed: `npm run verify` passed with 65 core test files, 1011 passed / 4 skipped, 7 Python
worker tests passed, and Docker Compose config rendered successfully.

- [ ] **Step 3: Commit, push, update PR, and verify checks**

Commit the runtime preflight fix, push `codex/iris-document-source-registry`, update PR #3, and
confirm GitHub Actions Core and AI Worker checks pass.
