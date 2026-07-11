# Iris Audit Query Metadata Design

## Goal

Make internal audit diagnostics less ambiguous for a small-company rollout. When an operator gets an empty or short audit result, they should know whether Iris has no retained events, whether the recent query window was small, or whether filters excluded the retained events.

## Scope

This phase adds response metadata to:

- `GET /internal/audit/events`
- `GET /internal/audit/events/summary`

It does not change audit recording, retention, storage, or the response item shapes.

## API

Both endpoints return a `meta` object:

- `limit`: parsed query limit after defaulting and clamping.
- `retainedEventCount`: total audit events currently retained in memory.
- `inspectedEventCount`: number of newest retained events inspected by this query window.
- `matchingEventCount`: number of inspected events matching the filters.
- `filters`: normalized filters applied to the query.

Example:

```json
{
  "ok": true,
  "meta": {
    "limit": 20,
    "retainedEventCount": 3,
    "inspectedEventCount": 3,
    "matchingEventCount": 1,
    "filters": {
      "documentId": "source-1",
      "type": "permission_guard_denied"
    }
  }
}
```

## Behavior

The metadata follows the same recent-window semantics as the endpoints:

1. Choose the newest `limit` retained events.
2. Apply optional `documentId` and `type` filters.
3. Return item data plus diagnostic metadata.

`limit=0` inspects zero events. This avoids JavaScript `slice(-0)` returning the full array and making diagnostics misleading.

## Quality Bar

Metadata must be additive, deterministic, and shared between raw events and summaries. It must not slow down Feishu ingestion or answer generation because it is computed only for internal diagnostic reads.
