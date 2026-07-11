# Iris Internal Status Degraded Component List Design

## Problem

The consolidated status summary reports how many components are degraded, but an admin UI still has to inspect the full component map to know which components need attention. For the first internal rollout, the status response should be directly actionable without extra client-side derivation.

## Decision

Add `summary.degradedComponents` to `GET /internal/status`:

```json
{
  "summary": {
    "componentCount": 5,
    "healthyComponentCount": 4,
    "degradedComponentCount": 1,
    "degradedComponents": ["eventWorker"]
  }
}
```

The list contains stable component keys from the `components` object, in the same order as the component map.

## Semantics

- Healthy snapshots return an empty list.
- Degraded snapshots include every component whose derived component `status` is `"degraded"` or
  `"stopped"`.
- The list length must match `degradedComponentCount`.

## Quality Bar

- Existing component payloads remain unchanged.
- The summary remains derived from the same component objects used to compute top-level `ok`.
- Degraded snapshots still return HTTP 200.
