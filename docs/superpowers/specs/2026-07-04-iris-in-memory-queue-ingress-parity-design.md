# Iris In-Memory Queue Ingress Parity Design

## Goal

Keep Phase 2B in-memory queue behavior aligned with Redis-backed queue identifier and payload
validation.

## Architecture

In-memory raw event, document sync, and document reindex queues now validate and normalize incoming
payloads before storing them:

- raw events reject oversized `idempotencyKey` and `eventType` fields,
- document sync jobs reject oversized or inconsistent `documentSourceId` / `idempotencyKey` fields,
- document reindex jobs reject oversized or inconsistent `embeddingProfileId`,
  `documentSnapshotId`, and `idempotencyKey` fields.

In-memory queues clone and store normalized payloads before deduplication, so whitespace-padded
valid IDs behave like Redis parser-normalized payloads.

## Invariants

- Valid in-memory queue behavior stays unchanged.
- Duplicate idempotency keys still dedupe.
- Completed idempotency keys can still be enqueued again after dequeue.
- Invalid direct queue inputs fail before entering memory.
- Phase 2B storage remains non-durable; this patch only aligns input semantics.

## Out Of Scope

- Adding persistence to in-memory queues.
- Changing Redis queue Lua scripts.
- Changing worker retry or DLQ policy.
- Adding migration/cleanup for previously queued in-memory state.
