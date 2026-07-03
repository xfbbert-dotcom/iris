# Iris Internal Status Schema Version Design

## Problem

`GET /internal/status` is becoming the contract for future admin UI and operational tooling. As fields evolve, clients need a stable way to know which response shape they are reading.

## Decision

Add top-level `schemaVersion: 1` to the consolidated internal status response:

```json
{
  "ok": true,
  "schemaVersion": 1,
  "generatedAt": "2026-07-03T07:30:00.000Z"
}
```

Version `1` covers the current response shape with top-level health, generated timestamp, summary, and component map.

## Semantics

- `schemaVersion` is the version of the status response schema, not the Iris product version.
- Additive fields may remain in version `1` while clients can ignore unknown fields.
- A future breaking shape change should increment the schema version.

## Quality Bar

- The field is top-level and always present.
- Existing status fields remain unchanged.
- Tests assert the version as part of the API contract.
