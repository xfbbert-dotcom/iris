# Iris Internal Status Error Message Budget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bound operational error messages before they enter `/internal/status`.

**Architecture:** Add `normalizeInternalStatusErrorMessage` and use it for Feishu gateway enqueue
failure snapshots.

**Tech Stack:** TypeScript, Vitest, existing internal status API tests.

---

### Task 1: Write Failing Test

**Files:**
- Modify: `apps/core/tests/answer-draft-api.test.ts`

- [x] **Step 1: Add gateway enqueue status test**

Trigger a raw-event queue enqueue failure with an oversized error and assert
`components.feishuGateway.latestEnqueueError.message` is capped to `1000` characters with
`[truncated]`.

- [x] **Step 2: Run focused test and confirm RED**

Run:

```powershell
npm --workspace apps/core test -- tests/answer-draft-api.test.ts -t "Feishu gateway enqueue failure"
```

Expected: the new test fails because the gateway status stores the full enqueue error.

Observed: the new test failed with a `1227` character status message.

### Task 2: Implement Internal Status Error Budget

**Files:**
- Create: `apps/core/src/admin/internal-status-error-message.ts`
- Modify: `apps/core/src/app.ts`

- [x] **Step 1: Add helper**

Implement a `1000` character internal status error budget with ` ... [truncated]`.

- [x] **Step 2: Apply to Feishu gateway enqueue errors**

Normalize `latestEnqueueError.message` while preserving original errors for enqueue observers.

- [x] **Step 3: Run focused test and confirm GREEN**

Run:

```powershell
npm --workspace apps/core test -- tests/answer-draft-api.test.ts -t "Feishu gateway enqueue failure"
```

Expected: focused gateway enqueue status tests pass.

Observed: focused tests passed with `2` matching tests.

### Task 3: Full Verification and Publication

**Files:**
- Create: `docs/superpowers/specs/2026-07-04-iris-internal-status-error-message-budget-design.md`
- Create: `docs/superpowers/plans/2026-07-04-iris-internal-status-error-message-budget.md`

- [x] **Step 1: Run full verification**

Run:

```powershell
npm run verify
```

Expected: the command exits 0.

Observed: `npm run verify` exited 0 with Core `777` passed / `4` skipped, Python `7` passed, and
`docker compose config` succeeded.

- [x] **Step 2: Commit, push, and verify PR checks**

Commit the internal status error budget helper, push `codex/iris-document-source-registry`,
update PR #3, and confirm GitHub Actions Core and AI Worker checks pass.

Observed: committed `03a3a29`, pushed to `codex/iris-document-source-registry`, updated PR #3,
and confirmed GitHub Actions Core and AI Worker checks passed.
