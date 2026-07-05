# Iris Redis Invalid Payload DLQ ACK Atomicity Design

## Context

Redis-backed queues move a payload from the pending queue into a processing list before Iris parses
it. If parsing or validation fails after dequeue, the worker writes a diagnostic DLQ entry so
operators can inspect the bad payload while normal work continues.

## Problem

Invalid-payload handling previously used separate Redis operations:

1. push the diagnostic DLQ payload;
2. remove the bad payload from the processing list;
3. optionally release the seen key when the payload safely exposes one.

If the DLQ push succeeded and cleanup failed, the same corrupt payload could appear in the DLQ and
still be recovered from processing on a later dequeue. If the optional seen-key release failed, safe
future work with the same idempotency key could remain blocked after the invalid payload was
diagnosed.

## Decision

Invalid queued payload handling for raw events, document sync jobs, and document reindex jobs must
reuse the dead-letter ACK Lua path. The script:

1. removes the exact original processing payload;
2. pushes the diagnostic DLQ payload only when that removal succeeds;
3. releases the seen key only when the caller supplies a safe idempotency key.

When the caller cannot prove a safe key, it passes an empty key argument. The script still records
the diagnostic and clears processing, but it does not release `seen`.

## Invariants

- Diagnostic DLQ entries keep stable generated ids and bounded error messages.
- Corrupt JSON and mismatched idempotency keys never release `seen`.
- Parseable but invalid payloads release `seen` only when their key matches the expected local
  derivation rules.
- The script writes a diagnostic only after removing the exact processing payload, preventing
  duplicate diagnostics on client retry after a successful Redis commit.
- The v1 queue remains single-consumer; this patch does not add leases.

## Out Of Scope

- DLQ replay/delete atomicity.
- Multi-consumer queue ownership.
- Redis key or payload schema changes.
