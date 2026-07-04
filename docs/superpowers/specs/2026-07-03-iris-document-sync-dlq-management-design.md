# Iris Document Sync DLQ Management Design

## Goal

Phase 3F upgrades document sync dead-letter handling from status-only observability to an operable recovery surface. Operators should be able to inspect failed document sync jobs, replay them after fixing the underlying cause, delete obsolete failures, and batch replay selected jobs.

## Architecture

Document sync DLQ management follows the existing document reindex DLQ model:

- The queue owns DLQ storage and replay/delete semantics.
- The runtime exposes a small `deadLetters` facade that delegates to the queue.
- Fastify exposes internal APIs for list, single replay, batch replay, and delete.
- Redis DLQ entries receive stable generated IDs. Legacy Redis entries without IDs remain listable but are marked `replayable: false`.

This keeps document sync and reindex operations consistent while preserving Phase 2B/3 in-memory development ergonomics.

## API Surface

- `GET /internal/document-sync/dead-letters?limit=20`
- `POST /internal/document-sync/dead-letters/:id/replay`
- `POST /internal/document-sync/dead-letters/replay` with `{ "ids": ["dlq-1"] }`
- `DELETE /internal/document-sync/dead-letters/:id`

Response and error style mirrors reindex DLQ APIs:

- Runtime unavailable: `503 { "ok": false, "error": "document_sync_worker_unavailable" }`
- Invalid request: `400 { "ok": false, "error": "invalid_request" }`
- Operation failure: `500 { "ok": false, "error": "document_sync_dead_letter_operation_failed" }`

## Invariants

- Replayed jobs reset `attempts` to `0`.
- Redis replay must enqueue the reset job before removing the DLQ payload. If enqueue fails, the
  original DLQ entry must remain recoverable.
- Legacy Redis DLQ entries without stable IDs are never replayed or deleted by synthetic IDs.
- Batch replay reports `replayedCount`, `notFoundIds`, and `unsupportedLegacyIds`.
- Listing is bounded by a sanitized limit capped at 100.
- Existing retry and max-attempt behavior remains unchanged.

## Out Of Scope

- Admin UI.
- Automatic replay policies.
- Changing retry backoff or worker scheduling.
- Persisting in-memory DLQ state across process restarts.
