# Iris Raw Event DLQ Management Design

## Goal

Give operators a recovery surface for Feishu raw event failures. When raw event processing reaches
the DLQ, Iris should not only expose a count; it should allow internal tooling to inspect replayable
events, replay selected items after the underlying issue is fixed, and delete obsolete failures.

## Architecture

Raw event DLQ management mirrors document sync and reindex DLQ management:

- The raw event queue owns DLQ storage, parsing, replay, and delete semantics.
- In-memory queues expose deterministic DLQ operations for local development and tests.
- Redis queues store new DLQ payloads with stable generated IDs.
- Legacy Redis DLQ payloads without stored IDs remain listable with synthetic diagnostic IDs but
  cannot be replayed or deleted.
- `EventWorkerRuntime` exposes a `deadLetters` facade that delegates to the queue.
- Fastify exposes internal routes under `/internal/events/dead-letters`.

## API Surface

- `GET /internal/events/dead-letters?limit=20`
- `POST /internal/events/dead-letters/:id/replay`
- `POST /internal/events/dead-letters/replay` with `{ "ids": ["dlq-1"] }`
- `DELETE /internal/events/dead-letters/:id`

Response and error style mirrors the existing event status and worker DLQ APIs:

- Runtime unavailable: `503 { "ok": false, "error": "event_worker_unavailable" }`
- Invalid request: `400 { "ok": false, "error": "invalid_request" }`
- Operation failure: `500 { "ok": false, "error": "event_dead_letter_operation_failed" }`

## Invariants

- Replayed raw events reset `attempts` to `0`.
- Redis replay must enqueue the reset event before removing the DLQ payload. If enqueue fails, the
  original DLQ entry must remain recoverable.
- Corrupt Redis queue payloads become non-replayable DLQ diagnostics with stable IDs for new
  entries.
- Legacy Redis DLQ entries without stored IDs are never replayed or deleted by synthetic IDs.
- Batch replay deduplicates requested IDs and reports `replayedCount`, `notFoundIds`, and
  `unsupportedLegacyIds`.
- Listing is bounded by the shared internal dead-letter limit parser.

## Out Of Scope

- Admin UI.
- Automatic replay policies.
- Changing worker retry/backoff behavior.
- Sending Feishu user-facing notifications for DLQ events.
