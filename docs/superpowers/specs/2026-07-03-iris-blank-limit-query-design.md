# Iris Blank Limit Query Design

## Problem

Several internal admin endpoints parse optional `limit` query parameters through `parseDeadLetterLimit()`. Because the parser uses `Number(value)`, a blank string such as `?limit=` is currently interpreted as `0`.

That can make an operator see an empty result set instead of a clear invalid request, which is poor feedback for a small internal rollout where debugging should be obvious.

## Requirements

- Keep omitted `limit` defaulting to `20`.
- Keep explicit `limit=0` valid.
- Reject blank or whitespace-only string values.
- Preserve existing integer range behavior and the `100` cap.

## Non-goals

- Do not change endpoint response shapes.
- Do not change explicit zero-limit behavior.
- Do not change list ordering or filtering.

## Acceptance

- `/internal/document-sync/sources?limit=` returns `400 invalid_request`.
- Existing `limit=0`, finite integer, and omitted limit behavior remains unchanged.
- Full verification remains green.
