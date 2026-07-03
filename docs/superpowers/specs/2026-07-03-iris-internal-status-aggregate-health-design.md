# Iris Internal Status Aggregate Health Design

## Problem

After component-level degraded status handling, `GET /internal/status` can return HTTP 200 even when one component is unhealthy. That is useful for visibility, but a fixed top-level `"ok": true` makes the backend homepage harder to scan because operators must inspect every component to know whether Iris is healthy.

## Decision

Keep HTTP 200 for an available status snapshot, but compute the response body's top-level `ok` from component health:

```json
{
  "ok": false,
  "components": {
    "eventWorker": {
      "ok": false,
      "enabled": true,
      "running": false,
      "error": "event_worker_status_failed"
    }
  }
}
```

If every component has `ok: true`, the aggregate response has `ok: true`. If any component has `ok: false`, the aggregate response has `ok: false`.

## Semantics

- HTTP status answers: "Can the operator read the status snapshot?"
- Body `ok` answers: "Is Iris healthy across the reported components?"
- Component `ok` answers: "Is this specific component healthy?"

## Quality Bar

- Degraded component snapshots must keep returning HTTP 200.
- The top-level `ok` must become `false` when any component is degraded.
- Existing all-healthy snapshots must keep returning `ok: true`.
