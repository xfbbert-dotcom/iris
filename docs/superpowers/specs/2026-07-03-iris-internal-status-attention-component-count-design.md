# Iris Internal Status Attention Component Count Design

## Problem

`summary.attentionComponents` gives admin clients the full prioritized list of components that need attention. For compact badges, filters, and navigation labels, clients still have to derive the count themselves.

For the first 20-30 person rollout, small admin UI surfaces should be able to render operational counts directly from the backend contract.

## Decision

Add `summary.attentionComponentCount` to `GET /internal/status`.

```json
{
  "summary": {
    "attentionComponentCount": 3
  }
}
```

The value is derived from `summary.attentionComponents.length`.

## Quality Bar

- The count must always equal the length of `attentionComponents`.
- The field must be present even when the count is zero.
- Snapshot builder and API tests must cover the field.
