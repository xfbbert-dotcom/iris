# Iris Raw Event Worker Limit Sanitization Design

## Problem

`RawEventWorker.processBatch()` floors negative and decimal limits, but it must also guard non-finite values and finite values beyond JavaScript's safe integer magnitude. `Infinity` can be passed through to `dequeueBatch()`, `NaN` can remain `NaN`, and unsafe finite values can distort operator intent before queue reads.

The worker loop validates its configured batch limit, but direct worker calls from tests, scripts, or future internal admin flows should still be defensive.

## Requirements

- Keep existing behavior for positive decimal limits: floor them.
- Keep existing behavior for negative limits: clamp to zero.
- Convert `Infinity`, `-Infinity`, and `NaN` to zero before calling the queue.
- Reject finite limits whose absolute value exceeds `Number.MAX_SAFE_INTEGER` before calling the queue.
- Match `DocumentSyncWorker` defensive behavior.

## Non-goals

- Do not change worker loop validation.
- Do not change queue implementations.
- Do not introduce a shared utility in this patch.

## Acceptance

- Direct raw event worker calls with `Infinity` and `NaN` call `dequeueBatch(0)`.
- Direct raw event worker calls with unsafe finite limits reject before dequeuing.
- Existing raw event worker processing and retry behavior remains passing.
- Full verification remains green.
