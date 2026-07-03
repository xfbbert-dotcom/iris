# Iris Internal Component Status Counts Design

## Problem

Each internal status component now exposes a direct `status`, but admin UI clients still need to iterate the component map to render counts or filter chips for healthy, disabled, degraded, and stopped components.

## Decision

Add `summary.componentStatusCounts` to `GET /internal/status`:

```json
{
  "summary": {
    "componentStatusCounts": {
      "healthy": 2,
      "disabled": 1,
      "degraded": 1,
      "stopped": 1
    }
  }
}
```

Counts are derived from the component-level `status` values after the snapshot builder applies status priority.

## Quality Bar

- The counts must include every supported component status key, even when the count is zero.
- The sum of all status counts must equal `summary.componentCount`.
- API and snapshot builder tests cover the field.
