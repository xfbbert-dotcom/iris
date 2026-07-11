# Iris Internal Status Component Order Design

## Problem

`GET /internal/status` returns components as a keyed object. JavaScript preserves insertion order for normal object keys, but admin UI code should not need to infer display order from object enumeration. A stable explicit order makes the component list easier and safer to render.

## Decision

Add top-level `componentOrder` to the consolidated internal status response:

```json
{
  "componentOrder": ["audit", "answerDraft", "eventWorker", "documentSync", "reindex"],
  "components": {}
}
```

The order is derived from the actual component map returned in the same response.

## Semantics

- `componentOrder` lists component keys only.
- Each key must exist in `components`.
- Clients can render rows by iterating `componentOrder` and reading `components[key]`.

## Quality Bar

- Existing component payloads remain unchanged.
- The order field is top-level so UI clients do not need to inspect `summary`.
- Tests assert the v1 component order.
