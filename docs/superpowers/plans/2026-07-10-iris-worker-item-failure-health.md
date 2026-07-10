# Iris Worker Item Failure Health Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent consolidated status from reporting workers healthy when their latest completed
batch contains failed items.

**Architecture:** Extend the shared consolidated worker-health adapter with a distinct
`latest_batch_items_failed` reason after DLQ and whole-batch failure checks. Preserve worker loops,
retry behavior, snapshot shapes, and worker-specific status endpoint semantics.

**Tech Stack:** TypeScript, Fastify, Vitest.

## Global Constraints

- Only consolidated `/internal/status` health mapping changes.
- Do not change queue retries, DLQ behavior, worker loops, or runtime status types.
- Precedence is `dead_letters_present`, `latest_batch_failed`,
  `latest_batch_items_failed`, then `mention_replies_unavailable`.
- Missing batches and completed batches with `failedCount = 0` remain healthy.

---

### Task 1: Specify Item-Failure Health

**Files:**
- Add: `docs/superpowers/specs/2026-07-10-iris-worker-item-failure-health-design.md`
- Add: `docs/superpowers/plans/2026-07-10-iris-worker-item-failure-health.md`
- Modify: `docs/superpowers/specs/2026-06-30-iris-architecture-whitepaper.md`

- [x] **Step 1: Distinguish batch invocation failure from handled item failures**
- [x] **Step 2: Define reason, precedence, and automatic recovery**
- [x] **Step 3: Preserve existing worker and queue contracts**

### Task 2: Drive Consolidated Health with Failing Tests

**Files:**
- Modify: `apps/core/tests/answer-draft-api.test.ts`

- [x] **Step 1: Cover all three workers with successful batches whose `failedCount` is positive**
- [x] **Step 2: Assert consolidated summary and `latest_batch_items_failed` reasons**
- [x] **Step 3: Assert DLQ and whole-batch failure precedence**
- [x] **Step 4: Assert recovery after a later zero-failure batch**
- [x] **Step 5: Run the focused test and verify RED**

Run:

```powershell
npm --workspace apps/core test -- tests/answer-draft-api.test.ts -t "latest completed batch contains failed items" --reporter=dot
```

Observed RED: document-sync and reindex remained healthy, while the event worker used the lower
priority `mention_replies_unavailable` reason. The recovery test also showed that a completed batch
with `failedCount = 1` stayed healthy.

### Task 3: Implement Shared Item-Failure Mapping

**Files:**
- Modify: `apps/core/src/app.ts`

- [x] **Step 1: Add the stable `latest_batch_items_failed` reason**
- [x] **Step 2: Extend `withWorkerHealth` after whole-batch failure handling**
- [x] **Step 3: Keep existing fields and precedence unchanged**
- [x] **Step 4: Run focused tests and verify GREEN**

Observed GREEN: `answer-draft-api.test.ts` passed all 161 tests.

### Task 4: Verify, Review, and Publish

- [x] **Step 1: Run `npm run verify`**
- [x] **Step 2: Complete independent review and address findings**
- [x] **Step 3: Commit and push the branch**
- [x] **Step 4: Watch PR #3 checks and confirm a clean merge state**

Observed: 65 Core test files passed with 1061 tests passed and 4 local Postgres tests skipped;
7 Python tests passed; TypeScript type checking and Docker Compose validation passed. Independent
review found no blocking issues. Its defensive `status === "succeeded"` recommendation was applied,
then focused and full verification passed again; re-review found no remaining issues.
Commits `3128eeb` and `91d0280` were pushed. PR #3 reported `CLEAN`; Core CI passed in
1m13s and AI Worker CI passed in 10s.
