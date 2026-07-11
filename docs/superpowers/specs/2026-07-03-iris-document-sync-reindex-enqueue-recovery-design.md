# Iris Document Sync Reindex Enqueue Recovery Design

## Context

Document sync has two durable side effects after a successful fetch: it writes a succeeded snapshot, then enqueues that snapshot for semantic reindexing. Previously, if snapshot writing and source marking succeeded but reindex enqueue failed, the worker treated the job as failed while the source remained `synced`.

That creates a bad recovery state: the retried sync job can see the source as already synced and skip it, leaving the latest snapshot without vector indexing.

## Decision

If reindex enqueue fails after a source is marked `synced`, the sync runner must mark the source back to `pending` before rethrowing the enqueue error. The existing worker retry path can then retry the sync job and reach the reindex enqueue step again.

## Scope

This only changes recovery after reindex enqueue failure. Fetch failures still produce failed snapshots and mark sources `failed`. Snapshot write failures and mark-synced failures still reject without recording failed snapshots.

## Quality Bar

- A successful fetch and snapshot write followed by reindex enqueue failure leaves the source retryable.
- The runner still reports a thrown error so the worker can apply queue retry policy.
- Existing successful sync and failed-fetch behavior remains unchanged.
