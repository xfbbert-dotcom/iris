# Iris Audit Summary Limit Sanitization Design

## Problem

`InMemoryAuditLog.summarizeRecent()` uses `this.events.slice(-options.limit)` directly. If an internal caller passes `Infinity` or `NaN`, the method can summarize all retained audit events instead of returning no recent window.

The audit log is operator-facing infrastructure; surprising bulk summaries make diagnosis harder.

## Requirements

- Treat `Infinity`, `-Infinity`, and `NaN` as zero.
- Preserve existing explicit zero behavior.
- Preserve finite limit behavior and summary sorting.

## Non-goals

- Do not change audit event retention.
- Do not change summary grouping or filters.
- Do not change API query parsing.

## Acceptance

- `summarizeRecent({ limit: Number.POSITIVE_INFINITY })` returns `[]`.
- `summarizeRecent({ limit: Number.NaN })` returns `[]`.
- Full verification remains green.
