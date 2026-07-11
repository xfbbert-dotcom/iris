# Iris Worker Latest Batch Health Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mark consolidated worker components degraded when their latest polling batch failed.

**Architecture:** Extend the existing consolidated status adapters in `app.ts`. Preserve worker-specific endpoint semantics and runtime snapshot types; add one shared latest-batch health helper after the existing DLQ check.

**Tech Stack:** TypeScript, Fastify, Vitest

## Global Constraints

- Only consolidated `/internal/status` health mapping changes.
- `latestBatch.status = "failed"` produces `degradedReason: "latest_batch_failed"`.
- Missing or successful latest batches do not degrade a worker.
- Precedence is `dead_letters_present`, then `latest_batch_failed`, then `mention_replies_unavailable`.
- Original runtime status fields remain visible.
- No queue, retry, DLQ, or worker-loop behavior changes.

---

### Task 1: Promote failed batch snapshots into consolidated health

**Files:**
- Modify: `apps/core/src/app.ts`
- Test: `apps/core/tests/answer-draft-api.test.ts`
- Modify: `docs/superpowers/specs/2026-06-30-iris-architecture-whitepaper.md`

**Interfaces:**
- Produces: `degradedReason: "latest_batch_failed"` on failed consolidated worker components
- Consumes: existing `latestBatch.status` discriminants from all three runtime status types

- [ ] **Step 1: Write the failing consolidated status test**

Create event, document-sync, and reindex fake runtimes with `running: true`, zero dead letters, and
`latestBatch.status: "failed"`. Assert all three components return `ok: false`,
`status: "degraded"`, and `degradedReason: "latest_batch_failed"`; assert the top-level summary lists
all three as degraded.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm --workspace apps/core test -- tests/answer-draft-api.test.ts -t "marks workers degraded when their latest batch failed"`

Expected: FAIL because current consolidated adapters return `ok: true` for zero-DLQ failed batches.

- [ ] **Step 3: Implement latest-batch health mapping**

Add a stable reason constant and a shared helper:

```ts
const latestBatchFailedReason = "latest_batch_failed" as const;

function withLatestBatchHealth<Status extends { latestBatch?: { status: string } }>(status: Status) {
  if (status.latestBatch?.status === "failed") {
    return { ok: false, ...status, degradedReason: latestBatchFailedReason };
  }
  return { ok: true, ...status };
}
```

Call it only after the existing DLQ health check. For the event worker, apply mention-reply health
only after latest-batch health so the documented precedence remains stable.

- [ ] **Step 4: Run focused and related status tests and verify GREEN**

Run: `npm --workspace apps/core test -- tests/answer-draft-api.test.ts -t "latest batch failed|dead-letter|mention replies|consolidated internal service status"`

Expected: PASS.

- [ ] **Step 5: Run full repository verification**

Run: `npm run verify`

Expected: Type checking, Core tests, Python worker tests, and Compose validation pass.

- [ ] **Step 6: Commit the verified implementation**

```bash
git add apps/core/src/app.ts apps/core/tests/answer-draft-api.test.ts docs/superpowers/specs/2026-06-30-iris-architecture-whitepaper.md docs/superpowers/specs/2026-07-10-iris-worker-latest-batch-health-design.md docs/superpowers/plans/2026-07-10-iris-worker-latest-batch-health.md
git commit -m "fix: degrade failed worker batch status"
```
