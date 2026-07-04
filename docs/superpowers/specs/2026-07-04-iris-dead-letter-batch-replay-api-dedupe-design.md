# Iris Dead Letter Batch Replay API Dedupe Design

## Goal

Normalize duplicate dead-letter IDs at the internal API boundary before replay requests reach
runtime facades. Admin tooling can produce duplicate selections, and the backend response should
reflect unique operator intent rather than repeated UI artifacts.

## Architecture

The existing queue implementations still deduplicate defensively. The shared
`parseDeadLetterBatchReplayRequest()` helper now also deduplicates IDs while preserving first-seen
order. All DLQ batch replay endpoints use this helper:

- `POST /internal/events/dead-letters/replay`
- `POST /internal/document-sync/dead-letters/replay`
- `POST /internal/reindex/dead-letters/replay`

The raw request array remains capped at 100 entries before dedupe so oversized payloads are still
rejected cheaply.

## Invariants

- Blank or non-string IDs are rejected.
- A request with no IDs is rejected.
- Requests with more than 100 raw IDs are rejected.
- Duplicate IDs are removed before the runtime `replayBatch()` call.
- First-seen ID order is preserved.

## Out Of Scope

- Changing queue-level dedupe.
- Changing response shape.
- Adding per-ID replay audit events.
