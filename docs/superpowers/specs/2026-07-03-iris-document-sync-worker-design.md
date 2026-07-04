# Iris Document Sync Worker Design

Date: 2026-07-03
Status: Phase 2Y design

## Goal

Phase 2Y adds a worker that consumes `DocumentSyncJob` items and invokes the existing `DocumentSyncRunner.syncSourceById(sourceId)`. This turns Phase 2X's producer-side enqueue path into an executable background workflow.

The end-to-end shape becomes:

```text
Feishu group message
-> document link discovery
-> group-visible DocumentSource registration
-> DocumentSyncJob enqueue
-> DocumentSyncWorker consume
-> DocumentSyncRunner syncSourceById
-> snapshot write through the existing runner
```

## Scope

In scope:

- Add `DocumentSyncWorker`.
- Add `DocumentSyncWorkerLoop`.
- Add batch result metadata for processed, skipped, rejected, not found, and failed jobs.
- Keep the worker thin: it delegates source state decisions to `DocumentSyncRunner`.

Out of scope:

- Retry and dead-letter handling for document sync jobs.
- Redis-backed document sync queue.
- Runtime/API status wiring for the document sync worker.
- Feishu document body fetching.
- Reindex enqueue after successful sync.

## Worker Contract

`DocumentSyncWorker` depends on:

- `DocumentSyncQueue.dequeueBatch(limit)`
- `DocumentSyncRunner.syncSourceById(sourceId)`

Direct `processBatch()` calls defensively sanitize non-finite limits to zero
and reject finite limits beyond JavaScript's safe integer magnitude before
calling `dequeueBatch()`. The worker loop also validates configured batch
limits before polling starts, but direct worker calls remain guarded so tests,
scripts, and future admin paths cannot bypass numeric safety.

For each dequeued job, the worker calls `syncSourceById(job.documentSourceId)`.

Result shape:

- `status: "processed"` for runner statuses `synced`, `skipped`, `rejected`, or `not_found`;
- `status: "failed"` when the runner throws.

Runner-level failed sync results are still processed worker results because the runner handled the failure and wrote a failed snapshot. Worker failure means the worker could not complete job processing.

## Loop Contract

`DocumentSyncWorkerLoop` mirrors the existing raw event worker loop:

- `start()`
- `stop()`
- `isRunning()`
- `getSnapshot()`

It records latest batch counts:

- `processedCount`
- `failedCount`

It does not overlap batches. It records batch-level exceptions and continues polling.

## Failure Strategy

Phase 2Y intentionally avoids queue retry/DLQ. That requires extending `DocumentSyncQueue` and should be a separate phase after the consumer shape is proven.

For now:

- runner-returned `failed` sync results count as processed;
- thrown errors count as failed;
- failed jobs are not requeued.

This is acceptable for v1 because the in-memory queue is already a local development producer path. Production durability will come with a Redis queue plus retry/DLQ design.

## Constitutional Alignment

The worker keeps event ingestion lightweight and moves document body synchronization into an async path. It does not bypass permissions or model-context guards. Permission behavior remains owned by the sync runner/fetcher and answer-time retrieval guardrails.
