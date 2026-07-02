# Iris Manual Document Sync Enqueue Design

## Goal

Phase 3G adds an operator-triggered way to enqueue a document source for body sync. This is needed after permissions are repaired, a document changes, or an operator wants Iris to re-read a known source without waiting for the document link to appear again in chat.

## Problem

The discovered-document sync path intentionally deduplicates by source:

```text
document-sync:<sourceId>
```

That is good for noisy Feishu groups, but it is wrong for manual re-sync. Once Redis has seen the discovered idempotency key, a later manual enqueue using the same key may be silently ignored forever.

## Architecture

Manual enqueue is a separate planner path:

- It finds a document source by ID.
- It rejects missing, denied, disabled, or currently syncing sources.
- It resets eligible `synced` or `failed` sources back to `pending`.
- It enqueues a document sync job with reason `manual_source_sync`.
- It uses a request-scoped idempotency key, not the discovered source-level key.

The document sync worker does not need special behavior. Once the job reaches the worker, it still calls `syncSourceById(sourceId)` and the existing runner state machine does the actual read.

## API

```http
POST /internal/document-sync/sources/:id/enqueue
```

Response:

```json
{
  "ok": true,
  "status": "enqueued",
  "documentSourceId": "source-1"
}
```

Possible statuses:

- `enqueued`
- `not_found`
- `rejected`
- `skipped`

Request validation:

- blank `:id` returns `400 invalid_request`;
- unavailable runtime returns `503 document_sync_worker_unavailable`;
- operation failures return `500 document_sync_enqueue_failed`.

## Invariants

- Manual enqueue must not bypass permission denial.
- Manual enqueue must not enqueue disabled sources where both answering and knowledge drafts are disabled.
- Manual enqueue must not enqueue sources already `syncing`.
- Manual enqueue may re-sync `synced` and `failed` sources by resetting state to `pending` before enqueueing.
- Manual enqueue uses `manual-source-sync:<sourceId>:<requestId>` as idempotency key.

## Out Of Scope

- Bulk enqueue.
- UI controls.
- Schedule-based periodic sync.
- Runtime persistence for admin toggles.
