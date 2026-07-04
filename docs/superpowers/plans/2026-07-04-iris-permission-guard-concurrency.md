# Iris Permission Guard Concurrency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve unique document permissions concurrently while preserving fail-closed filtering
semantics.

**Architecture:** Precompute permission resolutions for unique document IDs with `Promise.all`,
then assemble output and audit events in original fragment order.

**Tech Stack:** TypeScript, Vitest, existing permission guard tests.

---

### Task 1: Write Failing Test

**Files:**
- Modify: `apps/core/tests/permission-guard.test.ts`

- [x] **Step 1: Add concurrent permission resolution test**

Create fragments from three distinct documents with manually controlled permission promises. Assert
all three permission checks start before any promise resolves, then resolve them out of order and
assert output order remains tied to the original fragments.

- [x] **Step 2: Run focused test and confirm RED**

Run:

```powershell
npm --workspace apps/core test -- permission-guard.test.ts
```

Expected: the new test fails because the current guard resolves permissions sequentially.

Observed: the focused test failed because `canReadDocument` was called once instead of three times
before the first permission promise resolved.

### Task 2: Implement Concurrent Permission Resolution

**Files:**
- Modify: `apps/core/src/permissions/permission-guard.ts`

- [x] **Step 1: Resolve unique document IDs concurrently**

Use the existing grouped fragment map to get unique document IDs, resolve each permission with
`Promise.all`, and store results in a map.

- [x] **Step 2: Preserve filtering and audit order**

Iterate over the original fragment list after permissions resolve, using the permission map for
allowed/denied decisions and existing audit behavior.

- [x] **Step 3: Run focused test and confirm GREEN**

Run:

```powershell
npm --workspace apps/core test -- permission-guard.test.ts
```

Expected: permission guard tests pass.

Observed: focused permission guard tests passed with `9` tests.

### Task 3: Full Verification and Publication

**Files:**
- Create: `docs/superpowers/specs/2026-07-04-iris-permission-guard-concurrency-design.md`
- Create: `docs/superpowers/plans/2026-07-04-iris-permission-guard-concurrency.md`

- [x] **Step 1: Run full verification**

Run:

```powershell
npm run verify
```

Expected: the command exits 0.

Observed: `npm run verify` exited 0 with Core `811` passed / `4` skipped, Python `7` passed, and
`docker compose config` succeeded.

- [x] **Step 2: Commit, push, and verify PR checks**

Commit the permission guard concurrency patch, push `codex/iris-document-source-registry`, update
PR #3, and confirm GitHub Actions Core and AI Worker checks pass.

Observed: committed `ef92f7d`, pushed to `codex/iris-document-source-registry`, updated PR #3,
and confirmed GitHub Actions Core and AI Worker checks passed.
