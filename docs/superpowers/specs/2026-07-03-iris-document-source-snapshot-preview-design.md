# Iris Document Source Snapshot Preview Design

## Context

Iris can return source-owned snapshot detail without exposing document bodies. Operators sometimes need a small content sample to confirm whether a sync fetched the expected file, but returning full `bodyText` through an internal API would create a large accidental disclosure surface.

## Goal

Allow the snapshot detail endpoint to return an explicitly requested, length-limited body preview.

## Non-Goals

- No full body text endpoint.
- No preview support on the snapshot list endpoint.
- No body mutation, deletion, or redaction workflow.
- No per-user authorization model in this phase.

## HTTP API

### `GET /internal/document-sync/sources/:sourceId/snapshots/:snapshotId?previewLength=200`

Validation:

- `previewLength` is optional.
- When omitted, no `bodyTextPreview` is returned.
- When present, it must be an integer from `0` to `2000`.

Success:

```json
{
  "ok": true,
  "snapshot": {
    "id": "snapshot-1",
    "documentSourceId": "source-1",
    "sourceUri": "https://docs.feishu.cn/docx/doc_token_1",
    "fetchStatus": "succeeded",
    "fetchedAt": "2026-07-03T04:00:00.000Z",
    "createdAt": "2026-07-03T04:00:01.000Z",
    "bodyTextLength": 1234,
    "bodyTextPreview": "First 200 characters..."
  }
}
```

Behavior:

- Snapshot list summaries remain unchanged.
- Snapshot detail summaries include `bodyTextPreview` only when `previewLength` is explicitly provided and the snapshot has `bodyText`.
- `previewLength=0` is valid and returns an empty preview when body text exists.
- Failed snapshots without body text do not include a preview.

Errors:

- `400 invalid_request` for invalid `previewLength`.
- Existing detail endpoint errors remain unchanged.

## Architecture Notes

Preview is implemented in the HTTP summary mapping layer instead of the runtime. The runtime remains a source-owned snapshot lookup abstraction, while the API layer decides how much of the body, if any, is safe to serialize for operators.
