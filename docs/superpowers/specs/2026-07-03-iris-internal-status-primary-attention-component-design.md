# Iris Internal Status Primary Attention Component Design

## Problem

`summary.attentionComponents` gives admin clients the full list of components that need attention, but the first internal dashboard should also have a single backend-owned value for the top banner or compact health header.

Without this field, every admin client must remember that the first item in `attentionComponents` is the primary issue and must handle the healthy state itself.

## Decision

Add `summary.primaryAttentionComponent` to `GET /internal/status`.

```json
{
  "summary": {
    "primaryAttentionComponent": {
      "name": "eventWorker",
      "status": "degraded"
    }
  }
}
```

The value is the first item in `summary.attentionComponents`, after the existing `degraded -> stopped -> disabled` ordering is applied.

If there are no attention components, the value is `null`.

## Quality Bar

- The backend owns the primary attention decision.
- `primaryAttentionComponent` must always match `attentionComponents[0]` when the list is non-empty.
- `primaryAttentionComponent` must be `null` when every component is healthy.
- Snapshot builder and API tests must cover the field.
