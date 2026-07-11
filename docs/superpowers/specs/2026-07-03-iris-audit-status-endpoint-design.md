# Iris Audit Status Endpoint Design

## Goal

Give internal operators a cheap way to inspect audit log readiness and retention state without pulling audit event rows. This is useful for a 20-30 person rollout where the admin surface should make operational state obvious.

## Scope

This phase adds:

`GET /internal/audit/status`

The endpoint reports:

- `enabled`
- `storage`
- `retention.maxEventCount`
- `retention.retainedEventCount`
- `retention.droppedEventCount`

It does not add durable history, metrics export, alerts, or configuration changes.

## Behavior

The v1 endpoint returns:

```json
{
  "ok": true,
  "enabled": true,
  "storage": "in_memory",
  "retention": {
    "maxEventCount": 1000,
    "retainedEventCount": 0,
    "droppedEventCount": 0
  }
}
```

The values come from the same `InMemoryAuditLog.retention` state used by audit query metadata, so the status page and detail pages share one source of truth.

## Quality Bar

The endpoint must be read-only, cheap, and deterministic. It must not touch answer generation, Feishu ingestion, or audit event recording.
