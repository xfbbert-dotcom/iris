# Iris Audit Summary Limit Sanitization Design

## Problem

`InMemoryAuditLog.summarizeRecent()` uses `this.events.slice(-options.limit)` directly. If an internal caller passes `Infinity`, `NaN`, or a finite value beyond JavaScript's safe integer magnitude, the method can summarize all retained audit events instead of returning no recent window or rejecting distorted operator intent.

The audit log is operator-facing infrastructure; surprising bulk summaries make diagnosis harder.

## Requirements

- Treat `Infinity`, `-Infinity`, and `NaN` as zero.
- Reject finite limits whose absolute value exceeds `Number.MAX_SAFE_INTEGER`.
- Preserve existing explicit zero behavior.
- Preserve safe finite limit behavior and summary sorting.

## Non-goals

- Do not change audit event retention.
- Do not change summary grouping or filters.
- Do not change API query parsing.

## Acceptance

- `summarizeRecent({ limit: Number.POSITIVE_INFINITY })` returns `[]`.
- `summarizeRecent({ limit: Number.NaN })` returns `[]`.
- `summarizeRecent({ limit: Number.MAX_SAFE_INTEGER + 1 })` throws before summarizing retained audit events.
- Full verification remains green.
