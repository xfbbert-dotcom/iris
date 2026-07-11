# Iris Latest Snapshot Batch Lookup Design

## Context

`includeLatestSnapshot=true` on source inventory currently enriches rows by calling `sources.getLatestSnapshot()` once per source. This keeps the HTTP contract simple but creates an N+1 query pattern for admin list pages.

The database already has an index on `(document_source_id, fetched_at desc, id asc)`, which matches latest-per-source lookup.

## Goal

Replace source inventory latest snapshot enrichment with one batch latest snapshot lookup.

## Non-Goals

- No HTTP response shape change.
- No source detail behavior change.
- No full body text or preview in source inventory.
- No new table or materialized health cache.

## Repository Contract

`DocumentSnapshotRepository` adds:

```ts
findLatestSnapshotsForSources(documentSourceIds: string[]): Promise<DocumentSnapshot[]>;
```

Behavior:

- Return `[]` for an empty input without querying Postgres.
- Return at most one snapshot per source ID.
- Choose the latest snapshot by `fetched_at desc, id asc`.
- Return no row for sources without snapshots.

SQL shape:

```sql
select distinct on (document_source_id) *
from document_snapshots
where document_source_id = any($1::text[])
order by document_source_id asc, fetched_at desc, id asc
```

## Runtime Contract

`DocumentSyncRuntime.sources` adds:

```ts
getLatestSnapshots(input: {
  sourceIds: string[];
}): Promise<Map<string, DocumentSnapshot>>;
```

Behavior:

- Return an empty `Map` for empty input.
- Delegate to `findLatestSnapshotsForSources(sourceIds)`.
- Key the returned map by `snapshot.documentSourceId`.

## HTTP Behavior

`GET /internal/document-sync/sources?includeLatestSnapshot=true` keeps the same response body as Phase 3R, but internally uses `getLatestSnapshots({ sourceIds })` once.

Errors remain unchanged:

- `400 invalid_request`
- `500 document_source_lookup_failed`

## Architecture Notes

This change is a performance refactor with an explicit runtime method. Keeping the batch lookup below the API layer means future admin surfaces can reuse it without duplicating SQL or N+1 request loops.
