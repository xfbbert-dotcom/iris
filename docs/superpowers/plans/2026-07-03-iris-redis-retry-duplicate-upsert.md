# Iris Redis Retry Duplicate Upsert Plan

## Goal

Keep Redis retry attempts authoritative when a duplicate pending item already
exists for the same idempotency key.

## Tasks

- [x] Add failing tests for raw event, document sync, and document reindex Redis
  queues where an in-flight item fails while a duplicate pending item exists.
- [x] Replace retry-only `SADD`/`RPUSH` behavior with an atomic Redis Lua upsert
  that updates queued duplicates to the newest retry payload.
- [x] Preserve normal enqueue dedupe semantics for first-time queue writes.
- [x] Record the architecture guardrail in the Iris whitepaper.

## Verification

- `npm test -- tests/redis-raw-event-queue.test.ts tests/redis-document-sync-queue.test.ts tests/redis-document-reindex-queue.test.ts`
