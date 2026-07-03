# Iris Reindex Worker Limit Sanitization Design

## Problem

`DocumentReindexWorker.processBatch()` floors decimal and negative limits, but direct calls with `Infinity` or `NaN` can pass non-finite values into the queue.

The worker loop validates configured batch limits, but direct worker calls should still be defensive and consistent with document sync and raw event workers.

## Requirements

- Convert non-finite direct `processBatch()` limits to zero.
- Preserve floor/clamp behavior for finite values.
- Avoid changing worker loop validation or queue implementations in this patch.

## Non-goals

- Do not change reindex planning limits.
- Do not change indexing behavior or retry semantics.
- Do not introduce shared utilities in this patch.

## Acceptance

- Reindex worker calls with `Infinity` and `NaN` call `dequeueBatch(0)`.
- Existing indexing, skip, retry, and dead-letter behavior remains passing.
- Full verification remains green.
