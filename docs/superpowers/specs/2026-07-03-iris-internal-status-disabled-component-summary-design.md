# Iris Internal Status Disabled Component Summary Design

## Problem

The internal status summary distinguishes healthy and degraded components, but disabled components can still be healthy. Operators need to quickly tell the difference between "this is broken" and "this is intentionally unavailable or not configured".

For an early 20-30 person rollout, this helps explain why a feature is not active without treating that state as an incident.

## Decision

Add disabled component summary fields to `GET /internal/status`:

```json
{
  "summary": {
    "enabledComponentCount": 3,
    "disabledComponentCount": 2,
    "disabledComponents": ["answerDraft", "reindex"]
  }
}
```

These fields are derived from each component's existing `enabled` boolean.

## Semantics

- `enabledComponentCount`: components where `enabled` is true.
- `disabledComponentCount`: components where `enabled` is false.
- `disabledComponents`: stable component keys where `enabled` is false, in component-map order.

Disabled is not the same as degraded. A disabled component may still have `ok: true`.

## Quality Bar

- The disabled list length must match `disabledComponentCount`.
- Enabled and disabled counts must add up to `componentCount`.
- Existing health summary fields remain unchanged.
