# Iris Internal Status Enum Design

## Problem

`GET /internal/status` exposes top-level `ok`, but future admin UI still has to translate that boolean into a display state. A stable string enum makes the response easier to render and less error-prone for lightweight clients.

## Decision

Add top-level `status` to the consolidated internal status response:

```json
{
  "ok": false,
  "status": "degraded"
}
```

Version 1 supports two values:

- `healthy`: every component has `ok: true`;
- `degraded`: at least one component has `ok: false`.

## Semantics

`status` is derived from the same aggregate health decision as top-level `ok`. Disabled components can still be healthy, so disabled components alone do not make the status degraded.

## Quality Bar

- `status` must stay consistent with top-level `ok`.
- Healthy snapshots return `status: "healthy"`.
- Degraded snapshots return `status: "degraded"`.
