# Iris Repository Limit Sanitization Design

## Problem

Most queue and worker paths now sanitize non-finite limits. Two repository methods still pass `Math.max(0, Math.floor(limit))` results directly:

- Recent conversation messages by chat.
- Successful document snapshots missing an embedding profile.

`Infinity` can reach SQL as `LIMIT Infinity`, and `NaN` can reach query parameters as `NaN`. Finite values beyond JavaScript's safe integer magnitude can also distort operator intent before PostgreSQL applies `LIMIT`.

## Requirements

- Treat `Infinity`, `-Infinity`, and `NaN` as zero.
- Reject finite limits whose absolute value exceeds `Number.MAX_SAFE_INTEGER`.
- Preserve finite floor/clamp behavior.
- Apply the guard at repository boundaries, not only at callers.

## Non-goals

- Do not change default live chat limits.
- Do not change reindex planner behavior for valid finite limits.
- Do not change SQL ordering.

## Acceptance

- Conversation message recent-list queries send `LIMIT 0` for non-finite limits.
- Missing-profile snapshot queries send `LIMIT 0` for non-finite limits.
- Missing-profile snapshot queries reject unsafe finite limits before SQL.
- Full verification remains green.
