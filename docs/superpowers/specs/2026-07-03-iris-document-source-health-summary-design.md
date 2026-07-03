# Iris Document Source Health Summary Design

## Context

Iris can list sources and read the latest snapshot for one source. Admin source list screens need a compact sync health signal without making a separate latest-snapshot request for every row.

## Goal

Allow the source inventory API to optionally include each source's latest snapshot summary.

## Non-Goals

- No full body text or preview in source lists.
- No new persisted health table.
- No batch repository optimization in this phase.
- No latest successful-only calculation.

## HTTP API

### `GET /internal/document-sync/sources?includeLatestSnapshot=true`

Validation:

- `includeLatestSnapshot` is optional.
- When omitted, source inventory response is unchanged.
- When present, only `true` is accepted in this phase.

Success:

```json
{
  "ok": true,
  "sources": [
    {
      "id": "source-1",
      "sourceType": "authorized_wiki_document",
      "sourceUri": "https://docs.feishu.cn/docx/doc_token_1",
      "syncState": "pending",
      "latestSnapshot": {
        "id": "snapshot-1",
        "documentSourceId": "source-1",
        "sourceUri": "https://docs.feishu.cn/docx/doc_token_1",
        "fetchStatus": "failed",
        "fetchedAt": "2026-07-03T04:00:00.000Z",
        "errorMessage": "Feishu returned 403",
        "createdAt": "2026-07-03T04:00:01.000Z"
      }
    }
  ]
}
```

Behavior:

- Sources without snapshots omit `latestSnapshot`.
- Latest snapshot summaries never include `bodyText` or `bodyTextPreview`.
- Existing filters still work with `includeLatestSnapshot=true`.

Errors:

- `400 invalid_request` for invalid `includeLatestSnapshot`.
- `500 document_source_lookup_failed` if source or latest snapshot lookup fails.

## Architecture Notes

This is intentionally an API-layer view model. The runtime already exposes `sources.list()` and `sources.getLatestSnapshot()`, so the first implementation composes those calls in the handler. A later Postgres batch query can replace the N+1 lookup without changing the HTTP contract.
