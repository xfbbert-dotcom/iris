# Iris Document Sync Reindex Enqueue Design

Date: 2026-07-03
Status: Phase 3C design

## Goal

Phase 3C links successful document body sync to semantic reindexing. When Iris fetches a document body and records a successful snapshot, it should enqueue a `document_synced` reindex job for the active embedding profile.

## Scope

In scope:

- Add an optional post-success reindex hook to `DocumentSyncRunner`.
- Trigger the hook only after a succeeded snapshot is written and the document source is marked `synced`.
- Wire `DocumentSyncRuntime` to create a Redis-backed reindex planner when embedding config is available.
- Compute the active embedding profile id consistently with `ReindexWorkerRuntime`.
- Keep skipped, rejected, not-found, and failed sync results from enqueueing reindex jobs.

Out of scope:

- Running the reindex worker from document sync runtime.
- Changing reindex retry/DLQ behavior.
- Reindexing failed snapshots.
- Adding admin APIs for document sync reindex status.

## Design

`DocumentSyncRunner` gets an optional dependency:

```ts
syncedSnapshotReindexer?: {
  enqueueSyncedSnapshotReindex(input: {
    documentSnapshotId: string;
  }): Promise<void>;
}
```

The runner owns the exact success point because it already knows when a fetch has produced a successful snapshot. The runtime owns embedding profile selection because that is environment-specific configuration.

The call order for a successful sync becomes:

```text
find source
mark source syncing
fetch body
insert succeeded snapshot
mark source synced
enqueue synced snapshot reindex
return synced result
```

If enqueueing fails, `syncSourceById` should reject. This keeps the Redis document sync queue retry/DLQ phase meaningful later; silently succeeding would leave a fetched document out of semantic search.

## Runtime Wiring

`DocumentSyncRuntime` should:

- read `IRIS_EMBEDDING_PROVIDER`;
- when unset, skip automatic reindex enqueue;
- when set, require `IRIS_EMBEDDING_DIMENSIONS`;
- compute `openai-compatible:<model>:<dimensions>`;
- create a Redis document reindex queue using `REDIS_URL`;
- create `DocumentReindexPlanner`;
- pass a small adapter to `DocumentSyncRunner` that fills in `embeddingProfileId`.

This keeps document body sync usable in environments that have not enabled embeddings yet, while allowing production-like environments to connect the full pipeline.

## Redis Connections

The document sync runtime may use the same Redis connection for document sync queue consumption and reindex queue enqueueing because both queues only require Redis command methods exposed by the existing lazy client wrappers.

## Constitutional Alignment

This phase advances Iris from "can read document bodies" to "can make read documents retrievable for answering." It preserves the async architecture: Feishu ingestion discovers and enqueues, document sync fetches bodies, and reindex workers build vector context for answer-time retrieval.
