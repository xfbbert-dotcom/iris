# Iris Reindex Retry and DLQ Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Phase 2R of Iris: retry failed reindex jobs a bounded number of times, then move persistent failures to a dead-letter queue.

**Architecture:** Extend `DocumentReindexJob` with attempts and extend `DocumentReindexQueue` with failed-job handling and DLQ count. Update the worker to catch per-job processing errors, delegate retry/DLQ policy to the queue, and expose failed counts through loop/runtime status.

**Tech Stack:** TypeScript, Vitest, Redis lists, existing Iris reindex queue/worker/runtime modules.

---

## Scope

Implements `docs/superpowers/specs/2026-07-02-iris-reindex-retry-dlq-design.md`.

Modify:

```text
apps/core/src/reindex/document-reindex-queue.ts
apps/core/src/reindex/in-memory-document-reindex-queue.ts
apps/core/src/reindex/redis-document-reindex-queue.ts
apps/core/src/reindex/document-reindex-planner.ts
apps/core/src/reindex/document-reindex-worker.ts
apps/core/src/reindex/document-reindex-worker-loop.ts
apps/core/src/runtime/reindex-worker-runtime.ts
apps/core/tests/document-reindex-queue.test.ts
apps/core/tests/redis-document-reindex-queue.test.ts
apps/core/tests/document-reindex-planner.test.ts
apps/core/tests/document-reindex-worker.test.ts
apps/core/tests/document-reindex-worker-loop.test.ts
apps/core/tests/reindex-worker-runtime.test.ts
apps/core/tests/answer-draft-api.test.ts
```

## Task 1: Queue Attempts and DLQ

- [ ] Add tests for default `attempts: 0`, failed job requeue below max attempts, DLQ at max attempts, and DLQ count.
- [ ] Extend `DocumentReindexJob` with `attempts`.
- [ ] Extend `DocumentReindexQueue` with `handleFailedJob()` and `getDeadLetterCount()`.
- [ ] Implement retry/DLQ for in-memory queue.
- [ ] Implement retry/DLQ for Redis queue using `rPush` to queue or DLQ.
- [ ] Update Redis serialization parser to default missing attempts to 0.
- [ ] Run:

```powershell
npm --workspace apps/core test -- document-reindex-queue.test.ts redis-document-reindex-queue.test.ts
npm run typecheck
```

- [ ] Commit:

```powershell
git add apps/core/src/reindex/document-reindex-queue.ts apps/core/src/reindex/in-memory-document-reindex-queue.ts apps/core/src/reindex/redis-document-reindex-queue.ts apps/core/tests/document-reindex-queue.test.ts apps/core/tests/redis-document-reindex-queue.test.ts
git commit -m "feat: add reindex retry and DLQ queue contract"
```

## Task 2: Planner Attempts

- [ ] Update planner tests to expect `attempts: 0` on new jobs.
- [ ] Update planner-created jobs with `attempts: 0`.
- [ ] Run:

```powershell
npm --workspace apps/core test -- document-reindex-planner.test.ts
npm run typecheck
```

- [ ] Commit:

```powershell
git add apps/core/src/reindex/document-reindex-planner.ts apps/core/tests/document-reindex-planner.test.ts
git commit -m "feat: initialize reindex job attempts"
```

## Task 3: Worker Per-Job Failure Handling

- [ ] Add worker tests for processing error requeue, dead-letter, and continuing later jobs.
- [ ] Extend `DocumentReindexJobResult` with `status: "failed"`.
- [ ] Update `createDocumentReindexWorker` dependencies to use `handleFailedJob`.
- [ ] Catch per-job errors in `processBatch`.
- [ ] Return failed result with `retryAction`, `attempts`, and `errorMessage`.
- [ ] Run:

```powershell
npm --workspace apps/core test -- document-reindex-worker.test.ts
npm run typecheck
```

- [ ] Commit:

```powershell
git add apps/core/src/reindex/document-reindex-worker.ts apps/core/tests/document-reindex-worker.test.ts
git commit -m "feat: retry failed reindex jobs"
```

## Task 4: Loop and Runtime Status Failed Counts

- [ ] Add loop tests proving successful batch snapshots include `failedCount`.
- [ ] Add runtime/status tests proving `deadLetterJobCount` is returned.
- [ ] Update `ReindexWorkerBatchSnapshot` success shape with `failedCount`.
- [ ] Update runtime status with `deadLetterJobCount`.
- [ ] Update API status expected JSON to include `deadLetterJobCount`.
- [ ] Run:

```powershell
npm --workspace apps/core test -- document-reindex-worker-loop.test.ts reindex-worker-runtime.test.ts answer-draft-api.test.ts
npm run typecheck
```

- [ ] Commit:

```powershell
git add apps/core/src/reindex/document-reindex-worker-loop.ts apps/core/src/runtime/reindex-worker-runtime.ts apps/core/tests/document-reindex-worker-loop.test.ts apps/core/tests/reindex-worker-runtime.test.ts apps/core/tests/answer-draft-api.test.ts
git commit -m "feat: expose reindex DLQ status"
```

## Task 5: Final Verification and PR Update

- [ ] Run:

```powershell
npm run typecheck
npm test
```

- [ ] Run from `workers/ai`:

```powershell
python -m pytest
```

- [ ] Run:

```powershell
docker compose config
```

- [ ] Push and update PR:

```powershell
git push origin codex/iris-document-source-registry
$body = gh pr view 3 --repo xfbbert-dotcom/iris --json body --jq .body
$phase2R = "- Add Phase 2R reindex retry and DLQ: bounded per-job retries, dead-letter queue counts, and failed job status reporting."
if ($body -notlike "*Phase 2R reindex retry and DLQ*") {
  $body = $body -replace "(## Test Plan)", "$phase2R`n`n`$1"
}
$body | gh pr edit 3 --repo xfbbert-dotcom/iris --body-file -
gh pr view 3 --repo xfbbert-dotcom/iris --json number,state,isDraft,mergeable,headRefOid,url
```

## Self-Review Checklist

- Failed jobs do not disappear silently.
- Jobs stop retrying at max attempts.
- DLQ count is visible in status.
- One failed job does not stop the rest of the batch.
- No replay API is added in this phase.
- Final verification uses fresh command output.
