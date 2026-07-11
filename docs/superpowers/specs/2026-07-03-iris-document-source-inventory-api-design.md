# Iris Document Source Inventory API Design

## Context

Iris can now register document sources from three entrances:

- Documents observed in joined Feishu groups.
- Documents authorized from Feishu wiki spaces.
- Documents manually submitted by users.

The missing operator surface is read access: the backend can create and enqueue sources, but admins cannot inspect what Iris currently knows. Phase 3J adds a small internal inventory API so the future console can list sources, inspect a single source, and decide whether a manual sync or policy change is needed.

## Goals

- Expose a read-only internal API for document sources known to Iris.
- Reuse the existing document source registry instead of adding another store.
- Keep this phase safe: no writes, no sync side effects, no Feishu API calls.
- Support the most useful first filters for operations:
  - source type
  - origin group
  - authorized wiki space
  - submitting user
  - usable for answering

## Non-Goals

- No pagination cursor. The v1 endpoint accepts `limit` only.
- No compound filtering. A request can use at most one filter besides `limit`.
- No document body preview. Source inventory shows metadata and evidence only.
- No permission revalidation. The real-time permission guard remains part of answer generation, not this inventory endpoint.

## Runtime Contract

`DocumentSyncRuntime` adds a `sources` namespace:

```ts
type DocumentSourceInventoryListInput = {
  limit: number;
  sourceType?: DocumentSourceType;
  groupId?: string;
  authorizedSpaceId?: string;
  submittedByUserId?: string;
  usableForAnswering?: true;
};

type DocumentSyncRuntime = {
  sources: {
    list(input: DocumentSourceInventoryListInput): Promise<DocumentSource[]>;
    get(id: string): Promise<DocumentSource | undefined>;
  };
};
```

The implementation delegates to existing registry methods:

- no filter -> `listSources()`
- `sourceType` -> `listSourcesByType(sourceType)`
- `groupId` -> `listSourcesByGroupId(groupId)`
- `authorizedSpaceId` -> `listSourcesByAuthorizedSpaceId(authorizedSpaceId)`
- `submittedByUserId` -> `listSourcesBySubmittingUserId(submittedByUserId)`
- `usableForAnswering=true` -> `listSourcesUsableForAnswering()`
- detail -> `findSourceById(id)`

The runtime slices the result to `limit`. This keeps v1 compatible with both in-memory tests and Postgres registry methods without introducing query builder complexity.

## HTTP API

### `GET /internal/document-sync/sources`

Query parameters:

- `limit`: optional integer, default `20`, capped at `100`, cannot be negative.
- `sourceType`: optional; one of `group_visible_document`, `authorized_wiki_document`, `user_submitted_document`.
- `groupId`: optional non-blank string.
- `authorizedSpaceId`: optional non-blank string.
- `submittedByUserId`: optional non-blank string.
- `usableForAnswering`: optional; only `true` is accepted in v1.

Only one filter among `sourceType`, `groupId`, `authorizedSpaceId`, `submittedByUserId`, and `usableForAnswering` may be present.

Success:

```json
{
  "ok": true,
  "sources": []
}
```

Errors:

- `503 document_sync_worker_unavailable`
- `400 invalid_request`
- `500 document_source_lookup_failed`

### `GET /internal/document-sync/sources/:id`

Success:

```json
{
  "ok": true,
  "source": {}
}
```

Missing source:

```json
{
  "ok": false,
  "error": "document_source_not_found"
}
```

HTTP status: `404`.

Errors:

- `503 document_sync_worker_unavailable`
- `400 invalid_request`
- `404 document_source_not_found`
- `500 document_source_lookup_failed`

## Architecture Notes

This API intentionally belongs to `DocumentSyncRuntime` because it is an operational view of the document sync subsystem. It does not belong to answer drafting or Feishu gateway code.

The v1 one-filter rule is deliberately conservative. The registry already exposes single-purpose accessors, and a future console can still provide useful views without requiring compound SQL semantics now. If admins need compound filters later, we should add a dedicated `listSourcesByQuery()` registry method and cover it with Postgres integration tests.
