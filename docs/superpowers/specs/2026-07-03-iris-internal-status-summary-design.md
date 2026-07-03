# Iris Internal Status Summary Design

## Problem

`GET /internal/status` exposes detailed component health, but an operator or admin UI still has to inspect every component to show a concise health summary. For a small internal rollout, the first status screen should be immediately scannable.

## Decision

Add a top-level `summary` object to the consolidated internal status response:

```json
{
  "ok": false,
  "summary": {
    "componentCount": 5,
    "healthyComponentCount": 4,
    "degradedComponentCount": 1
  },
  "components": {}
}
```

The summary is derived from the same component objects used to compute top-level `ok`.

## Semantics

- `componentCount`: number of reported components.
- `healthyComponentCount`: components with `ok: true`.
- `degradedComponentCount`: components with `ok: false`.

## Quality Bar

- The summary must stay consistent with top-level `ok`.
- Healthy snapshots report zero degraded components.
- Degraded snapshots still return HTTP 200 and include the summary.
