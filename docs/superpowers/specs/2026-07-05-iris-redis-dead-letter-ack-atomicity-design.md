# Iris Redis Dead-Letter ACK Atomicity Design

## Context

Redis-backed queues move failed raw events, document sync jobs, and document reindex jobs into a
DLQ when they reach their max-attempt threshold. That transition is terminal for the worker-owned
processing claim, but operators can still inspect, replay, or delete DLQ entries later.

## Problem

Dead-letter handling previously used three Redis operations:

1. push the DLQ payload;
2. remove the original payload from the processing list;
3. release the idempotency key from the seen set.

If any later operation failed after the DLQ push, Iris could expose the same logical work both as a
dead-letter entry and as a recoverable processing payload. If the seen-key release failed, future
replay or new work with the same idempotency key could be blocked after the worker had already
terminally classified the item.

## Decision

Max-attempt failure handling for raw events, document sync jobs, and document reindex jobs must use
one Redis `eval` script that:

1. removes the exact original processing payload;
2. pushes the DLQ payload only when that removal succeeds;
3. releases the corresponding seen key in the same script.

The script intentionally gates DLQ insertion on removing the exact processing payload. If the
client times out after Redis commits the script and retries the same ACK, the second script run
finds no processing payload and does not duplicate the DLQ entry.

## Invariants

- DLQ payloads keep stable generated ids and bounded error messages.
- Seen keys are released only by processed ACK or max-attempt dead-letter ACK.
- Retriable failures keep using the retry ACK script and do not release seen keys.
- DLQ replay keeps using retry/upsert semantics because replay starts from the DLQ, not the
  processing list.
- The v1 queue remains single-consumer; this patch does not add leases.

## Out Of Scope

- Multi-consumer queue ownership.
- DLQ replay/delete atomicity.
- Redis key or payload schema changes.
