# Iris Redis Processed ACK Atomicity Design

## Context

Redis-backed queues keep a `seen` set for idempotency and a `processing` list for in-flight work.
When a worker finishes successfully, ACK must clear both pieces of state.

## Problem

If ACK uses two separate Redis commands, `LREM processing` can succeed and `SREM seen` can fail. The
job is then absent from both pending and processing lists, while its idempotency key still blocks
future enqueue attempts.

This is especially risky for document sync and reindex jobs because their idempotency key is stable
for a source or snapshot/profile pair.

## Decision

Successful ACK for raw events, document sync jobs, and document reindex jobs must use one Redis
`eval` script that:

1. removes the exact processing payload;
2. releases the corresponding seen key only if that payload was removed;
3. returns after both mutations are committed by Redis.

## Invariants

- Dequeue keeps idempotency keys claimed until successful ACK.
- Failed processing continues to use retry/dead-letter handling.
- DLQ replay and retry upsert behavior is unchanged.
- The v1 queue remains single-consumer; this patch does not add leases.

## Out Of Scope

- Atomic retry/dead-letter transitions.
- Multi-consumer queue ownership.
- Redis key or payload schema changes.
