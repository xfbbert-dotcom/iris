# Iris Document Source Latest Snapshot Design

## Context

Iris can list source snapshots and read a specific snapshot by ID. Admin screens often need only the newest sync attempt for a source, and forcing clients to list snapshots then select the first row repeats logic across callers.

The snapshot repository already has `findLatestSnapshotForSource(documentSourceId)`.

## Goal

Expose a source-owned latest snapshot lookup through the document sync runtime and internal API.

## Non-Goals

- No latest successful-only endpoint.
- No full body text endpoint.
- No change to snapshot ordering semantics in the list endpoint.
- No retry or mutation behavior.

## Runtime Contract

`DocumentSyncRuntime.sources` adds:

```ts
getLatestSnapshot(input: {
  sourceId: string;
}): Promise<DocumentSnapshot | undefined>;
```

Behavior:

- Check source existence through `findSourceById(sourceId)`.
- Return `undefined` when the source is missing.
- Otherwise return `findLatestSnapshotForSource(sourceId)`.
- Return `undefined` when the source exists but has no snapshots.

## HTTP API

### `GET /internal/document-sync/sources/:id/snapshots/latest`

Validation:

- `:id` must be non-blank.
- Optional `previewLength` follows the same `0` to `2000` validation as snapshot detail.

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
    "bodyTextLength": 1234
  }
}
```

Errors:

- `503 document_sync_worker_unavailable`
- `400 invalid_request`
- `404 document_source_snapshot_not_found`
- `500 document_source_snapshot_lookup_failed`

## Architecture Notes

Latest snapshot lookup is a convenience read model over existing snapshot storage. It deliberately returns the same snapshot summary shape as list/detail APIs and uses the same preview guard so clients do not need a separate rendering path.
