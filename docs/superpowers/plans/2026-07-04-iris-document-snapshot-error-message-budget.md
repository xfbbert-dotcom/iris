# Iris Document Snapshot Error Message Budget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bound document fetch failure messages before they are returned or stored in failed
snapshots.

**Architecture:** Add `normalizeDocumentSnapshotErrorMessage` and use it in the sync runner and
snapshot repository.

**Tech Stack:** TypeScript, Vitest, existing document sync and snapshot repository tests.

---

### Task 1: Write Failing Tests

**Files:**
- Modify: `apps/core/tests/document-sync-pipeline.test.ts`
- Modify: `apps/core/tests/document-snapshot-repository.test.ts`

- [x] **Step 1: Add sync runner test**

Throw an oversized fetch error and assert the failed snapshot writer receives a bounded
`errorMessage`; the returned failed sync result and snapshot should also expose the bounded message.

- [x] **Step 2: Add repository boundary test**

Insert a failed snapshot with an oversized `errorMessage` and assert the SQL parameter and returned
snapshot are both capped to `1000` characters with `[truncated]`.

- [x] **Step 3: Run focused tests and confirm RED**

Run:

```powershell
npm --workspace apps/core test -- tests/document-sync-pipeline.test.ts tests/document-snapshot-repository.test.ts
```

Expected: tests fail because oversized document snapshot error messages are currently stored
unchanged.

Observed: both new tests failed; the sync runner passed the full oversized error into
`insertFailedSnapshot`, and the repository attempted to insert a `1227` character error message.

### Task 2: Implement Snapshot Error Budget

**Files:**
- Create: `apps/core/src/documents/document-snapshot-error-message.ts`
- Modify: `apps/core/src/documents/document-sync-pipeline.ts`
- Modify: `apps/core/src/documents/document-snapshot-repository.ts`

- [x] **Step 1: Add helper**

Implement a `1000` character document snapshot error budget with ` ... [truncated]`.

- [x] **Step 2: Apply to sync runner failures**

Normalize fetch failure messages before returning failed sync results or passing the message to
snapshot writers.

- [x] **Step 3: Apply to failed snapshot inserts**

Normalize failed snapshot insert messages at the repository boundary.

- [x] **Step 4: Run focused tests and confirm GREEN**

Run:

```powershell
npm --workspace apps/core test -- tests/document-sync-pipeline.test.ts tests/document-snapshot-repository.test.ts
```

Expected: the document sync and snapshot repository test files pass.

Observed: focused tests passed with `34` tests and `1` environment-skipped Postgres test.

### Task 3: Full Verification and Publication

**Files:**
- Create: `docs/superpowers/specs/2026-07-04-iris-document-snapshot-error-message-budget-design.md`
- Create: `docs/superpowers/plans/2026-07-04-iris-document-snapshot-error-message-budget.md`

- [x] **Step 1: Run full verification**

Run:

```powershell
npm run verify
```

Expected: the command exits 0.

Observed: `npm run verify` exited 0 with Core `773` passed / `4` skipped, Python `7` passed, and
`docker compose config` succeeded.

- [ ] **Step 2: Commit, push, and verify PR checks**

Commit the document snapshot error budget helper, push `codex/iris-document-source-registry`,
update PR #3, and confirm GitHub Actions Core and AI Worker checks pass.
