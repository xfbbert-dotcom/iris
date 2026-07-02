# Iris Document Source Snapshot Inventory Design

## Context

Iris can now list document sources and manually trigger sync, but operators cannot inspect recent sync snapshots for a source through the internal API. Without that view, a source may look registered while the last body fetch actually failed.

The snapshot repository already stores succeeded and failed fetch attempts in `document_snapshots`.

## Goal

Expose a read-only internal API that lists recent sync snapshot summaries for one document source.

## Non-Goals

- No full body text exposure in this endpoint.
- No snapshot deletion or retry.
- No fragment/index coverage reporting.
- No pagination cursor; v1 uses only `limit`.

## Runtime Contract

`DocumentSyncRuntime.sources` adds:

```ts
listSnapshots(input: {
  id: string;
  limit: number;
}): Promise<DocumentSnapshot[] | undefined>;
```

Behavior:

- Check source existence through `findSourceById(id)`.
- Return `undefined` when the source is missing.
- Otherwise read `listSnapshotsForSource(id)` from the snapshot repository.
- Slice to `limit`.

## HTTP API

### `GET /internal/document-sync/sources/:id/snapshots?limit=20`

Validation:

- `:id` must be non-blank.
- `limit` defaults to `20`, must be an integer `>= 0`, and is capped at `100`.

Success:

```json
{
  "ok": true,
  "snapshots": [
    {
      "id": "snapshot-1",
      "documentSourceId": "source-1",
      "sourceUri": "https://docs.feishu.cn/docx/doc_token_1",
      "fetchStatus": "succeeded",
      "contentHash": "sha256...",
      "sourceVersion": "optional",
      "fetchedAt": "2026-07-03T03:00:00.000Z",
      "createdAt": "2026-07-03T03:00:00.000Z",
      "bodyTextLength": 1234
    }
  ]
}
```

Failed snapshots include `errorMessage`. The endpoint does not include `bodyText`.

Errors:

- `503 document_sync_worker_unavailable`
- `400 invalid_request`
- `404 document_source_not_found`
- `500 document_source_snapshot_lookup_failed`

## Architecture Notes

This endpoint belongs under the document source inventory surface because snapshots are operational evidence for a source. It deliberately returns summaries rather than full snapshots to avoid exposing large document bodies through a list endpoint.
