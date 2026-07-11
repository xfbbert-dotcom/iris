# Iris Redis Retry ACK Atomicity Design

## Context

Redis-backed queues keep pending work in a queue list and in-flight work in a processing list. When
processing fails below the max-attempt threshold, Iris requeues the same logical work with an
incremented attempt count.

## Problem

Retry handling used two Redis operations:

1. upsert the retry payload into the pending queue;
2. remove the original payload from the processing list.

If the first operation succeeds and the second fails, the retry is pending while the original
processing payload still exists. A later recovery can move the original payload back to pending,
creating duplicate retry surfaces or stale attempt metadata.

## Decision

Retriable failure handling for raw events, document sync jobs, and document reindex jobs must use
one Redis `eval` script that:

1. adds or upgrades the retry payload in the pending queue;
2. removes the exact original processing payload;
3. returns only after Redis commits both effects.

## Invariants

- Duplicate pending retry payloads are upgraded in place when possible.
- If a stale `seen` key exists without a queued duplicate, retry still pushes the retry payload.
- DLQ replay keeps using retry/upsert semantics because it does not own a processing payload.
- Processed ACK remains the only path that releases `seen` keys after successful processing.
- The v1 queue remains single-consumer; this patch does not add leases.

## Out Of Scope

- Atomic dead-letter transitions.
- Multi-consumer queue ownership.
- Redis key or payload schema changes.
