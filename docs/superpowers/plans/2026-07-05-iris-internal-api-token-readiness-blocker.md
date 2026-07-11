# Iris Internal API Token Readiness Blocker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this
> plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make missing `IRIS_INTERNAL_API_TOKEN` block the internal rollout readiness profile.

**Architecture:** Keep the runtime server behavior unchanged for local development, but tighten the
pre-rollout readiness contract.

**Tech Stack:** TypeScript, Vitest.

---

### Task 1: Failing Readiness Test

**Files:**
- Modify: `apps/core/tests/internal-rollout-readiness.test.ts`

- [x] **Step 1: Add missing-token blocker coverage**

Assert an otherwise ready rollout environment with blank `IRIS_INTERNAL_API_TOKEN` returns
`ok: false`, `status: "blocked"`, and a failed `internalApiToken` check.

- [x] **Step 2: Verify RED**

Run the readiness test and confirm the report still returns ok before the implementation change.

### Task 2: Readiness Policy Change

**Files:**
- Modify: `apps/core/src/admin/internal-rollout-readiness.ts`
- Modify: `apps/core/tests/internal-rollout-readiness.test.ts`

- [x] **Step 1: Change missing token from warn to fail**

Return a failed check when `IRIS_INTERNAL_API_TOKEN` is missing or blank.

- [x] **Step 2: Update existing missing-config expectations**

Existing broad missing-config tests should expect `internalApiToken.status` to be `fail`.

- [x] **Step 3: Verify GREEN**

Run readiness, readiness CLI, and readiness API tests.

### Task 3: Documentation And Full Verification

- [x] Update the internal rollout runbook and architecture whitepaper.
- [x] Run `npm run verify`.
