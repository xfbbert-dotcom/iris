# Iris Internal Status Degraded Components Design

## Problem

`GET /internal/status` is the backend homepage snapshot for Iris operators. A single worker status check can fail because Redis, a queue adapter, or a runtime dependency is temporarily unavailable. If that exception propagates, the entire consolidated status endpoint returns 500 and operators lose visibility into healthy components.

For the first 20-30 internal users, the status surface should favor clear visibility over perfect completeness: one broken component should be shown as broken, while the rest of the system remains inspectable.

## Decision

The consolidated internal status endpoint catches failures from component status providers and returns a degraded component payload:

```json
{
  "ok": false,
  "enabled": true,
  "running": false,
  "error": "event_worker_status_failed"
}
```

The aggregate endpoint still returns HTTP 200 and preserves the status payloads for other components.

## Component Error Codes

- `event_worker_status_failed`
- `document_sync_status_failed`
- `reindex_status_failed`

## Non-Goals

- This does not change individual component endpoints. Dedicated worker status endpoints may still expose their own failures directly.
- This does not hide operational incidents. Failed components are marked with `ok: false` and a stable error code.
- This does not introduce persistence or alerting. Alerting belongs in a later observability phase.

## Quality Bar

- The aggregate endpoint must remain available when a single component status check throws.
- Healthy components must keep their full status shape in the same response.
- Disabled runtimes remain `ok: true`, `enabled: false`, `running: false`.
