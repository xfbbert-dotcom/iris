# Iris Redis Retry Duplicate Upsert Design

## Context

Redis-backed Iris queues deduplicate pending work by idempotency key. Dequeue
releases that key so lost in-flight work can be recovered. That creates a narrow
but important retry window: a duplicate item with `attempts = 0` can enter Redis
while the original item is still processing.

If the original item then fails, retry handling must not leave the older pending
duplicate in place. Otherwise retry counters can be reset or delayed, making DLQ
behavior less predictable.

## Decision

Failed retry handling for Redis raw event, document sync, and document reindex
queues uses an atomic Lua upsert:

- if the idempotency key is absent, add it and push the retry payload;
- if the idempotency key already exists and a queued payload with the same
  `idempotencyKey` is found, replace it with the retry payload;
- if the key exists but no matching queued payload is found, push the retry
  payload so the failed work is not silently lost.

Normal first-time enqueue remains a pure deduplicating `SADD`/`RPUSH` path.

## Scope

This hardens retry state only. It does not change max-attempt policy, DLQ
schemas, payload parsing, or worker-loop scheduling.

## Verification

- RED: focused Redis queue tests showed pending duplicates stayed at
  `attempts = 0`.
- GREEN: focused Redis queue tests pass after retry paths atomically upsert the
  pending duplicate.
