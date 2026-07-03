# Iris Queue Limit Sanitization Design

## Problem

Several queue implementations sanitize decimal and negative limits with `Math.max(0, Math.floor(limit))`, but this does not guard non-finite values. `Infinity` can cause in-memory queues to dequeue everything, and Redis queues can still issue at least one pop/range call.

Workers now sanitize direct batch limits, but queue implementations are public infrastructure and should be defensive at their own boundary too.

## Requirements

- Treat `Infinity`, `-Infinity`, and `NaN` limits as zero.
- Preserve floor/clamp behavior for finite decimal and negative values.
- Apply the guard to in-memory raw event queue dequeue.
- Apply the guard to in-memory reindex queue dequeue and DLQ listing.
- Apply the guard to Redis raw event, document sync, and document reindex queue dequeue.
- Apply the guard to Redis document sync and document reindex DLQ listing.

## Non-goals

- Do not change worker loop validation.
- Do not change queue serialization formats.
- Do not change retry or dead-letter semantics.

## Acceptance

- Queue calls with non-finite limits return empty results and do not consume queue entries.
- Redis queue calls with non-finite limits do not call `lPop` or `lRange`.
- Full verification remains green.
