# Iris Internal Status Stopped Runtime Health Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development and superpowers:verification-before-completion.

**Goal:** Make enabled stopped runtimes degrade the consolidated internal status.

**Architecture:** Keep component status derivation unchanged. Add stopped-enabled-runtime awareness to the top-level `ok` calculation so intentional disabled components remain informational while stopped enabled workers are not reported as healthy.

**Tech Stack:** TypeScript, Vitest.

---

### Task 1: Add Regression Coverage

**Files:**
- Modify: `apps/core/tests/internal-status-snapshot.test.ts`

- [x] **Step 1: Add stopped-runtime top-level health test**

Build a snapshot with one enabled runtime component where `ok: true` and `running: false`.

- [x] **Step 2: Confirm red**

Run: `npm --workspace apps/core test -- tests/internal-status-snapshot.test.ts`

Expected: fails because top-level `ok` is still true.

### Task 2: Apply Health Rule

**Files:**
- Modify: `apps/core/src/admin/internal-status-snapshot.ts`
- Modify: `docs/superpowers/specs/2026-06-30-iris-architecture-whitepaper.md`
- Modify: `docs/operations/internal-rollout-runbook.md`

- [x] **Step 1: Include stopped runtimes in top-level health**

Require `stoppedEnabledRuntimeComponents.length === 0` before reporting top-level `ok: true`.

- [x] **Step 2: Run focused status tests**

Run internal status snapshot, consolidated status API, runtime-control API, and readiness API tests.

- [x] **Step 3: Run full verification**

Run: `npm run verify`

Expected: all local verification commands pass.
