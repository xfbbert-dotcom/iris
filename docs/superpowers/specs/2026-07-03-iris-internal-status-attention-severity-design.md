# Iris Internal Status Attention Severity Design

## Problem

`summary.attentionComponents` and `summary.primaryAttentionComponent` tell admin clients what needs attention, but the first internal dashboard still needs a stable severity value for colors, badges, and compact health headers.

Deriving severity in every client risks inconsistent UI treatment for the same backend state.

## Decision

Add `summary.attentionSeverity` to `GET /internal/status`.

```json
{
  "summary": {
    "attentionSeverity": "critical"
  }
}
```

The value is derived from `summary.primaryAttentionComponent.status`:

- `degraded` -> `critical`
- `stopped` -> `warning`
- `disabled` -> `info`
- no primary attention component -> `none`

## Quality Bar

- The backend owns the severity mapping.
- The field must be present on every status response.
- Snapshot builder tests must cover mixed-status and all-healthy states.
- API tests must cover the field in both existing `/internal/status` scenarios.
