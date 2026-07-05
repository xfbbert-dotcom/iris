# Iris Mention Reply Status Degradation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this
> plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mark consolidated event worker health as degraded when @Iris mention replies are
unavailable because required wiring is missing.

**Architecture:** Keep `/internal/events/status` unchanged and map mention-reply wiring failures
only in the `/internal/status` adapter.

**Tech Stack:** TypeScript, Fastify app injection tests, Vitest.

---

### Task 1: Failing Status Test

**Files:**
- Modify: `apps/core/tests/answer-draft-api.test.ts`

- [x] **Step 1: Add failing consolidated status expectation**

Assert that an otherwise running event worker with `mentionRepliesEnabled: false`,
`mentionRepliesUnavailableReason`, and zero DLQs becomes degraded with
`degradedReason: "mention_replies_unavailable"`.

- [x] **Step 2: Verify RED**

Run the focused API test and confirm the new test fails because the component is currently healthy.

### Task 2: Status Adapter Implementation

**Files:**
- Modify: `apps/core/src/app.ts`

- [x] **Step 1: Implement mention reply health mapping**

Add an event-worker-specific health adapter. Preserve `dead_letters_present` precedence, then mark
missing mention reply wiring as degraded.

- [x] **Step 2: Verify GREEN**

Run the focused API test and confirm it passes.

### Task 3: Documentation And Verification

**Files:**
- Modify: `docs/superpowers/specs/2026-06-30-iris-architecture-whitepaper.md`
- Modify: `docs/operations/internal-rollout-runbook.md`

- [x] **Step 1: Update architecture and rollout docs**

Record that `/internal/status` must surface mention reply wiring failures.

- [x] **Step 2: Run relevant regression tests**

Run focused API/status tests and TypeScript checks.

- [x] **Step 3: Run full verification, commit, push, and watch PR checks**

Run `npm run verify`, commit, push `codex/iris-document-source-registry`, and confirm PR checks.
