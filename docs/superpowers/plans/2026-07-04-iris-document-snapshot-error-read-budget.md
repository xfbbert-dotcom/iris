# Iris Document Snapshot Error Read Budget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bound failed snapshot error messages read from database rows.

**Architecture:** Reuse `normalizeDocumentSnapshotErrorMessage` in `mapSnapshotRow` so legacy rows
are bounded before repository callers or admin APIs receive them.

**Tech Stack:** TypeScript, Vitest, existing document snapshot repository tests.

---

### Task 1: Write Failing Test

**Files:**
- Modify: `apps/core/tests/document-snapshot-repository.test.ts`

- [x] **Step 1: Add legacy row mapping test**

Return a failed snapshot row with an oversized `error_message` from the queryable and assert the
repository result is capped to `1000` characters with `[truncated]`.

- [x] **Step 2: Run focused test and confirm RED**

Run:

```powershell
npm --workspace apps/core test -- tests/document-snapshot-repository.test.ts
```

Expected: the new test fails because `mapSnapshotRow` currently returns database `error_message`
unchanged.

Observed: the new test failed with a `1227` character error message.

### Task 2: Implement Snapshot Read Error Budget

**Files:**
- Modify: `apps/core/src/documents/document-snapshot-repository.ts`

- [x] **Step 1: Apply helper in row mapper**

Normalize non-null `row.error_message` in `mapSnapshotRow`.

- [x] **Step 2: Run focused test and confirm GREEN**

Run:

```powershell
npm --workspace apps/core test -- tests/document-snapshot-repository.test.ts
```

Expected: document snapshot repository tests pass.

Observed: focused tests passed with `13` tests and `1` environment-skipped Postgres test.

### Task 3: Full Verification and Publication

**Files:**
- Create: `docs/superpowers/specs/2026-07-04-iris-document-snapshot-error-read-budget-design.md`
- Create: `docs/superpowers/plans/2026-07-04-iris-document-snapshot-error-read-budget.md`

- [x] **Step 1: Run full verification**

Run:

```powershell
npm run verify
```

Expected: the command exits 0.

Observed: `npm run verify` exited 0 with Core `783` passed / `4` skipped, Python `7` passed, and
`docker compose config` succeeded.

- [x] **Step 2: Commit, push, and verify PR checks**

Commit the document snapshot read error budget, push `codex/iris-document-source-registry`,
update PR #3, and confirm GitHub Actions Core and AI Worker checks pass.

Observed: committed `6525459`, pushed to `codex/iris-document-source-registry`, updated PR #3,
and confirmed GitHub Actions Core and AI Worker checks passed.
