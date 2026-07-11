# Iris Internal Status Operator Attention Flag Design

## Problem

Admin clients can derive whether Iris needs human attention from `attentionComponentCount`, but each client still has to repeat the same boolean check for banners, red dots, and notification toggles.

For the internal 20-30 person rollout, the backend should expose the operational decision directly.

## Decision

Add `summary.requiresOperatorAttention` to `GET /internal/status`.

```json
{
  "summary": {
    "requiresOperatorAttention": true
  }
}
```

The value is `true` when `summary.attentionComponentCount > 0`; otherwise it is `false`.

## Quality Bar

- The flag must always match `attentionComponentCount > 0`.
- The field must be present on every status response.
- Snapshot builder tests must cover both attention and all-healthy states.
- API tests must cover the field in the existing `/internal/status` scenarios.
