# Iris Document Source Detail Health Design

## Context

Iris source inventory rows can optionally include latest snapshot summaries. The source detail endpoint still requires a second latest-snapshot request for the same operational signal.

## Goal

Allow source detail responses to optionally include the source's latest snapshot summary.

## Non-Goals

- No full body text or preview in source detail enrichment.
- No new runtime method.
- No mutation behavior.
- No latest successful-only calculation.

## HTTP API

### `GET /internal/document-sync/sources/:id?includeLatestSnapshot=true`

Validation:

- `includeLatestSnapshot` is optional.
- When omitted, source detail response is unchanged.
- When present, only `true` is accepted.

Success:

```json
{
  "ok": true,
  "source": {
    "id": "source-1",
    "sourceType": "authorized_wiki_document",
    "sourceUri": "https://docs.feishu.cn/docx/doc_token_1",
    "latestSnapshot": {
      "id": "snapshot-1",
      "documentSourceId": "source-1",
      "sourceUri": "https://docs.feishu.cn/docx/doc_token_1",
      "fetchStatus": "succeeded",
      "fetchedAt": "2026-07-03T04:00:00.000Z",
      "createdAt": "2026-07-03T04:00:01.000Z",
      "bodyTextLength": 1234
    }
  }
}
```

Behavior:

- Sources without snapshots omit `latestSnapshot`.
- `latestSnapshot` never includes `bodyText` or `bodyTextPreview`.

Errors:

- `400 invalid_request` for invalid source ID or invalid `includeLatestSnapshot`.
- `404 document_source_not_found` when the source is missing.
- `500 document_source_lookup_failed` when source or latest snapshot lookup fails.

## Architecture Notes

This endpoint reuses the same `parseIncludeLatestSnapshot()` and `toDocumentSnapshotSummary()` behavior as the inventory endpoint. Keeping source detail and source list enrichment aligned avoids two admin UI view models for the same health signal.
