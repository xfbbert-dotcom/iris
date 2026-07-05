# Iris Redis DLQ Replay Atomicity Design

## Context

Redis-backed queues expose DLQ replay so operators can move failed raw events, document sync jobs,
and document reindex jobs back into pending work with attempts reset to zero.

## Problem

Replay previously used two Redis transitions:

1. enqueue/upsert the reset work payload into the pending queue;
2. remove the original payload from the DLQ list.

If enqueue succeeded and DLQ removal failed, the same logical work could be pending and still
visible as replayable DLQ work. A later operator retry could enqueue it again after the first replay
had already succeeded.

## Decision

DLQ replay must use one Redis `eval` script that:

1. removes the exact DLQ payload;
2. enqueues the reset payload when the seen key is new;
3. updates an existing queued duplicate when the seen key is already claimed and a duplicate exists;
4. pushes the reset payload when the seen key is stale and no queued duplicate exists.

If exact DLQ removal returns zero, the script returns zero without enqueuing. The caller reports the
entry as not found in that case.

## Invariants

- Replay resets attempts to zero.
- Replay preserves retry/upsert semantics for stale seen keys and queued duplicates.
- Replay does not remove unsupported legacy or invalid diagnostic DLQ entries.
- Replay no longer calls a separate `LREM` after enqueue.
- The v1 queue remains single-consumer; this patch does not add leases.

## Out Of Scope

- Atomic DLQ delete for non-replay actions.
- Multi-consumer queue ownership.
- Redis key or payload schema changes.
