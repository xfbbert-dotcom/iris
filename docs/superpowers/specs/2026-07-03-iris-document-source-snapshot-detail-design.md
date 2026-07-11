# Iris Document Source Snapshot Detail Design

## Context

Iris can list recent sync snapshots for a document source, but operators still cannot drill into one specific sync attempt through a stable internal API. The list endpoint is enough for scanning, while a detail endpoint gives the admin console a direct target for source-owned evidence inspection.

## Goal

Expose a read-only internal API that returns one sync snapshot summary for one document source.

## Non-Goals

- No full body text exposure in this endpoint.
- No snapshot body preview.
- No snapshot deletion or retry.
- No cross-source snapshot lookup.
- No fragment/index coverage reporting.

## Runtime Contract

`DocumentSyncRuntime.sources` adds:

```ts
getSnapshot(input: {
  sourceId: string;
  snapshotId: string;
}): Promise<DocumentSnapshot | undefined>;
```

Behavior:

- Check source existence through `findSourceById(sourceId)`.
- Return `undefined` when the source is missing.
- Read `findSnapshotById(snapshotId)` from the snapshot repository.
- Return `undefined` when the snapshot is missing.
- Return `undefined` when the snapshot belongs to a different source.
- Otherwise return the snapshot.

## HTTP API

### `GET /internal/document-sync/sources/:sourceId/snapshots/:snapshotId`

Validation:

- `:sourceId` must be non-blank.
- `:snapshotId` must be non-blank.

Success:

```json
{
  "ok": true,
  "snapshot": {
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
}
```

Failed snapshots include `errorMessage`. The endpoint does not include `bodyText`.

Errors:

- `503 document_sync_worker_unavailable`
- `400 invalid_request`
- `404 document_source_snapshot_not_found`
- `500 document_source_snapshot_lookup_failed`

## Architecture Notes

The detail endpoint reuses the same snapshot summary shape as the inventory endpoint so the admin UI can render list rows and detail pages with one view model. Ownership is enforced in the runtime instead of the HTTP handler so any future caller receives the same cross-source guard.
