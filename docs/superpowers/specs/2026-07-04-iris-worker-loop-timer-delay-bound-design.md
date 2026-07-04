# Iris Worker Loop Timer Delay Bound Design

## Context

Worker loops use `setTimeout()` for raw event, document sync, and document
reindex polling. They already reject non-positive, non-integer, and unsafe
integer values, but a positive safe integer above Node's maximum timer delay can
overflow into a very short delay.

## Decision

Every worker loop must reject `intervalMs` values above `2147483647` before the
loop starts. This guard applies only to timer delay fields:

- `intervalMs` is capped at Node's maximum timer delay.
- `batchLimit` remains a positive safe integer guard and does not inherit the
  timer-specific cap.
- Existing zero, negative, fractional, and unsafe integer error behavior remains
  unchanged.

## Error Handling

Out-of-range worker intervals throw:

`intervalMs must not exceed 2147483647`

## Testing

Add focused boundary tests to all three worker loop test suites, then run the
worker-loop tests and full verification.
