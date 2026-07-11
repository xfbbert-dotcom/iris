# Iris Feishu Legacy Idempotency Design

## Problem

The Feishu Gateway primarily writes callbacks to the raw event queue, where missing event ids fall back to a stable body hash. The legacy in-memory queue path still falls back to a random UUID when both the `x-iris-event-id` header and top-level `event_id` are missing.

That means a retried Feishu callback without those ids can be stored twice in the legacy queue. The compatibility path is not the normal production path, but it is still used by tests, lightweight local deployments, and any runtime configuration that omits the raw event worker.

## Requirements

- Keep preferring `x-iris-event-id` when present.
- Accept Feishu v2-style `body.header.event_id` before falling back.
- Keep accepting legacy top-level `body.event_id`.
- Fall back to the same stable body hash used by the raw event path.
- Preserve the existing nonblank idempotency key behavior.

## Non-goals

- Do not change the raw event queue idempotency prefix.
- Do not introduce cryptographic hashing in this patch.
- Do not change Feishu signature verification or callback acknowledgement timing.

## Acceptance

- A legacy callback with only `header.event_id` uses that normalized idempotency key.
- Two identical legacy callbacks without explicit ids produce one stored event.
- Existing Feishu Gateway and app route behavior remains passing.
