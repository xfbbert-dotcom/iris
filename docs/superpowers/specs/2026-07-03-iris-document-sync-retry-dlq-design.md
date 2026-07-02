# Iris Document Sync Retry And DLQ Design

Date: 2026-07-03
Status: Phase 3E design

## Goal

Phase 3E adds retry and dead-letter handling for document sync jobs when the worker itself cannot complete job processing.

## Scope

In scope:

- Extend `DocumentSyncQueue` with failed-job handling.
- Add Redis-backed retry and DLQ support to `RedisDocumentSyncQueue`.
- Add in-memory retry and DLQ support for tests/local composition.
- Update `DocumentSyncWorker` to delegate thrown runner failures to the queue.
- Expose `deadLetterJobCount` in `DocumentSyncRuntime.getStatus()`.

Out of scope:

- Admin APIs to list, replay, or delete document sync DLQ entries.
- Retrying runner-handled failed sync results. Those are considered processed because the runner wrote a failed snapshot and source state.
- Visibility timeout or leasing semantics.

## Semantics

Runner result handling:

- `synced`, `failed`, `skipped`, `rejected`, `not_found`: processed worker result.
- thrown error: queue `handleFailedJob`.

Queue failure actions:

- below max attempts: increment `attempts`, push back to queue, worker result `failed` with `retryAction: "requeued"`;
- at max attempts: push to DLQ, worker result `failed` with `retryAction: "dead_lettered"`.

Default max attempts is `3`, matching raw events and reindex jobs.

## Redis Keys

Default keys:

- Queue: `iris:documents:sync:queue`
- DLQ: `iris:documents:sync:dlq`

DLQ payload stores:

- job
- errorMessage
- failedAt

## Status

`DocumentSyncRuntimeStatus` adds:

```ts
deadLetterJobCount: number
```

This lets the internal status route report when document sync jobs are falling out of the retry loop.

## Constitutional Alignment

Document sync is now a production async lane. Retry/DLQ keeps transient Feishu or network failures from silently disappearing and gives operators a clear signal when documents need intervention.
