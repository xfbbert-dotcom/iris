# Iris Reindex Observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Phase 2Q of Iris: expose reindex worker status, Redis queue depth, and latest worker batch results.

**Architecture:** Extend existing queue and worker-loop boundaries with read-only observability methods. Surface those through `ReindexWorkerRuntime.getStatus()` and a new internal `GET /internal/reindex/status` route.

**Tech Stack:** TypeScript, Vitest, Fastify, Redis npm client, existing Iris reindex runtime.

---

## Scope

Implements `docs/superpowers/specs/2026-07-02-iris-reindex-observability-design.md`.

Create or modify:

```text
apps/core/src/reindex/document-reindex-queue.ts
apps/core/src/reindex/in-memory-document-reindex-queue.ts
apps/core/src/reindex/redis-document-reindex-queue.ts
apps/core/src/reindex/document-reindex-worker-loop.ts
apps/core/src/runtime/reindex-worker-runtime.ts
apps/core/src/app.ts
apps/core/tests/document-reindex-queue.test.ts
apps/core/tests/redis-document-reindex-queue.test.ts
apps/core/tests/document-reindex-worker-loop.test.ts
apps/core/tests/reindex-worker-runtime.test.ts
apps/core/tests/answer-draft-api.test.ts
```

## Task 1: Queue Pending Count

- [ ] Add tests proving in-memory queue pending count changes after enqueue/dequeue.
- [ ] Add tests proving Redis queue calls `lLen` on `iris:reindex:documents:queue`.
- [ ] Extend `DocumentReindexQueue` with `getPendingCount(): Promise<number>`.
- [ ] Implement `getPendingCount` for in-memory and Redis queues.
- [ ] Run:

```powershell
npm --workspace apps/core test -- document-reindex-queue.test.ts redis-document-reindex-queue.test.ts
npm run typecheck
```

- [ ] Commit:

```powershell
git add apps/core/src/reindex/document-reindex-queue.ts apps/core/src/reindex/in-memory-document-reindex-queue.ts apps/core/src/reindex/redis-document-reindex-queue.ts apps/core/tests/document-reindex-queue.test.ts apps/core/tests/redis-document-reindex-queue.test.ts
git commit -m "feat: expose reindex queue depth"
```

## Task 2: Worker Loop Latest Batch Snapshot

- [ ] Add tests proving `getSnapshot()` returns running state, interval, batch limit.
- [ ] Add tests proving successful batches record indexed/skipped counts.
- [ ] Add tests proving failed batches record an error message and keep polling behavior.
- [ ] Add `ReindexWorkerBatchSnapshot` type and `getSnapshot()` to `DocumentReindexWorkerLoop`.
- [ ] Update loop implementation to store latest succeeded or failed batch snapshot.
- [ ] Run:

```powershell
npm --workspace apps/core test -- document-reindex-worker-loop.test.ts
npm run typecheck
```

- [ ] Commit:

```powershell
git add apps/core/src/reindex/document-reindex-worker-loop.ts apps/core/tests/document-reindex-worker-loop.test.ts
git commit -m "feat: track reindex worker batch status"
```

## Task 3: Runtime Status

- [ ] Add runtime test proving `getStatus()` combines active profile id, loop snapshot, and queue depth.
- [ ] Extend `ReindexWorkerRuntime` with `getStatus()`.
- [ ] Ensure runtime dependencies require queues with `getPendingCount`.
- [ ] Run:

```powershell
npm --workspace apps/core test -- reindex-worker-runtime.test.ts
npm run typecheck
```

- [ ] Commit:

```powershell
git add apps/core/src/runtime/reindex-worker-runtime.ts apps/core/tests/reindex-worker-runtime.test.ts
git commit -m "feat: expose reindex runtime status"
```

## Task 4: Internal Status API

- [ ] Add API tests for disabled runtime, available runtime, and status failure.
- [ ] Add `GET /internal/reindex/status`.
- [ ] Return disabled status directly when runtime is unavailable.
- [ ] Map runtime status failures to `500 reindex_status_failed`.
- [ ] Run:

```powershell
npm --workspace apps/core test -- answer-draft-api.test.ts
npm run typecheck
```

- [ ] Commit:

```powershell
git add apps/core/src/app.ts apps/core/tests/answer-draft-api.test.ts
git commit -m "feat: add internal reindex status API"
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
$phase2Q = "- Add Phase 2Q reindex observability: internal worker status API, Redis queue depth, and latest batch snapshot."
if ($body -notlike "*Phase 2Q reindex observability*") {
  $body = $body -replace "(## Test Plan)", "$phase2Q`n`n`$1"
}
$body | gh pr edit 3 --repo xfbbert-dotcom/iris --body-file -
gh pr view 3 --repo xfbbert-dotcom/iris --json number,state,isDraft,mergeable,headRefOid,url
```

## Self-Review Checklist

- Status endpoint is read-only.
- Queue depth does not expose job payloads.
- Latest batch snapshot is in-memory only.
- Worker loop still survives batch failures.
- Disabled runtime still does not connect Redis or Postgres.
- Final verification uses fresh command output.
