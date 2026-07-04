# Iris DLQ Status Degradation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this
> plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mark consolidated internal worker components as degraded when their DLQ count is non-zero.

**Architecture:** Keep individual status endpoints unchanged, and apply the DLQ-to-health mapping
only in the `/internal/status` component adapters.

**Tech Stack:** TypeScript, Fastify app injection tests, Vitest.

---

### Task 1: Failing Status Snapshot Tests

**Files:**
- Modify: `apps/core/tests/answer-draft-api.test.ts`

- [x] **Step 1: Add failing consolidated status expectations**

Assert that event, document sync, and reindex components with non-empty DLQs become degraded and
carry `degradedReason: "dead_letters_present"` in `/internal/status`.

- [x] **Step 2: Verify RED**

Run the focused API test and confirm it fails before implementation.

### Task 2: Status Adapter Implementation

**Files:**
- Modify: `apps/core/src/app.ts`

- [x] **Step 1: Implement DLQ health mapping**

Add small helpers that convert worker status payloads into `{ ok: false, degradedReason:
"dead_letters_present" }` when the matching DLQ count is greater than zero.

- [x] **Step 2: Verify GREEN**

Run the focused API test and typecheck.

### Task 3: Documentation And Full Verification

**Files:**
- Modify: `docs/superpowers/specs/2026-06-30-iris-architecture-whitepaper.md`

- [x] **Step 1: Update whitepaper**

Record the invariant that consolidated operator health must surface non-empty DLQs as degraded.

- [x] **Step 2: Run full verification**

Run:

```powershell
npm run typecheck
npm test
python -m pytest
docker compose config
```

- [x] **Step 3: Commit, push, and verify PR checks**

Commit the implementation, push `codex/iris-document-source-registry`, update PR #3, and confirm
GitHub Actions returns Core and AI Worker success.
