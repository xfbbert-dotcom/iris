# Iris Internal Status Snapshot Design

## Goal

Give the admin backend a single lightweight endpoint for the current Iris service snapshot. The small-company rollout should not require an operator to call several internal endpoints just to know whether the main background systems are alive.

## Scope

This phase adds:

`GET /internal/status`

It aggregates:

- audit log status and retention
- answer draft availability
- event worker status
- document sync worker status
- reindex worker status

It does not add alerting, historical metrics, dashboards, or durable health records.

## Response Shape

```json
{
  "ok": true,
  "components": {
    "audit": { "ok": true, "enabled": true, "storage": "in_memory" },
    "answerDraft": { "ok": true, "enabled": true },
    "eventWorker": { "ok": true, "enabled": true, "running": true },
    "documentSync": { "ok": true, "enabled": true, "running": true },
    "reindex": { "ok": true, "enabled": true, "running": false }
  }
}
```

The component objects preserve their existing status fields so the admin UI can show details without calling each endpoint.

## Behavior

Unavailable workers report `{ ok: true, enabled: false, running: false }`, matching existing individual status endpoints. Audit always reports the v1 in-memory state. Answer draft reports whether an orchestrator is available.

## Quality Bar

The endpoint must be read-only and cheap. It should not start work, enqueue jobs, read documents, or change runtime state.
