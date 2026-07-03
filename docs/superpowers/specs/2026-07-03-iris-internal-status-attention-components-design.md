# Iris Internal Status Attention Components Design

## Problem

`GET /internal/status` already exposes per-component status and summary counts, but an admin UI still has to duplicate prioritization logic to decide which components need human attention.

For the first 20-30 person internal rollout, the backend should make the operational status easy to scan without adding a separate incident system.

## Decision

Add `summary.attentionComponents` to `GET /internal/status`.

```json
{
  "summary": {
    "attentionComponents": [
      { "name": "answerDraft", "status": "degraded" },
      { "name": "reindex", "status": "stopped" },
      { "name": "documentSync", "status": "disabled" }
    ]
  }
}
```

The list is derived from component-level `status` values after status priority is applied.

## Ordering

Components are ordered by urgency:

1. `degraded`
2. `stopped`
3. `disabled`

Within the same status, components keep the original component map order. `healthy` components are excluded.

## Quality Bar

- The backend owns attention ordering so all admin clients render the same operational priority.
- The list must include only `degraded`, `stopped`, and `disabled` components.
- The field must be present even when empty.
- Snapshot builder and API tests must cover the field.
