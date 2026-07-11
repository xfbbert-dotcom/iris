# Iris Worker Result Error Message Budget Design

## Goal

Prevent oversized per-job worker failures from leaking into direct worker `processBatch` results or
queue failure handlers.

## Architecture

Generalize the worker diagnostic helper to `normalizeWorkerErrorMessage` and use it across:

- Raw event worker failed event results.
- Document sync worker thrown runner failures.
- Document reindex worker processing failures.
- Existing worker loop failed batch snapshots.

The helper keeps a single `1000` character budget with ` ... [truncated]` so direct worker callers,
retry handlers, and loop snapshots all see the same bounded diagnostic shape.

## Invariants

- Successful worker results are unchanged.
- Worker batch-limit guards are unchanged.
- Short failure messages remain unchanged except for trimming.
- Queue retry and dead-letter behavior remains unchanged; queue layers still keep their own DLQ
  storage boundary.

## Out Of Scope

- Preserving full error details in direct `processBatch` return values.
- Redacting secret patterns inside worker errors.
- Changing retry attempts, replay behavior, or worker loop scheduling.
- Changing the internal status API response shape.
