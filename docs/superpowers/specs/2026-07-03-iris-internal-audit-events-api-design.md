# Iris Internal Audit Events API Design

## Context

Phase 3W made answer draft permission denials auditable, but there is no internal way to inspect those events during a running local/internal deployment.

For the first 20-30 person rollout, a lightweight in-memory audit view is enough. It helps operators answer: "Did Iris ignore this document because permission policy rejected it?"

## Goal

Add an internal endpoint that lists recent in-memory audit events captured by the app process.

## Non-Goals

- No persistent audit storage.
- No auth layer in this phase.
- No filtering beyond `limit`.
- No mutation or delete API.
- No changes to answer draft response shape.

## Behavior

`GET /internal/audit/events?limit=20`

Response:

```json
{
  "ok": true,
  "events": [
    {
      "type": "permission_guard_denied",
      "documentId": "source-denied",
      "fragmentIds": ["fragment-1"],
      "message": "optional message"
    }
  ]
}
```

Rules:

- default `limit` is 20;
- maximum `limit` is 100;
- invalid limit returns `400 invalid_request`;
- newest events are returned first;
- event objects are cloned so callers cannot mutate the in-memory log.

## Architecture

`buildApp()` creates an `InMemoryAuditLog` unless one is injected. The default answer draft runtime receives the same audit log. The audit endpoint reads from that in-memory log.

This keeps the feature useful for early internal debugging without creating a persistence abstraction before the team needs one.

## Testing

- The audit endpoint returns newest events first and respects `limit`.
- Invalid limits return `400 invalid_request`.
- When the app composes the default answer draft runtime, it passes the shared audit log into runtime creation.
