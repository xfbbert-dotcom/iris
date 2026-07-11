# Iris Document Source Policy API Design

## Context

Iris now has a document source inventory API. Operators can see which documents Iris knows, but they still cannot control whether an individual source may be used in answers or knowledge draft generation.

The underlying registries already have two policy toggles:

- `setAnsweringEnabled(id, enabled)`
- `setKnowledgeDraftsEnabled(id, enabled)`

Phase 3K exposes those existing controls through the document sync runtime and internal HTTP API.

## Goals

- Let an operator update source usage policy for one document source.
- Keep policy changes separate from sync, indexing, and Feishu permission checks.
- Return the final persisted source after all requested policy changes.
- Preserve the registry safety rule where denied sources cannot be re-enabled for answering.

## Non-Goals

- No bulk policy updates.
- No audit log table in this phase.
- No automatic reindex or resync.
- No source deletion or archival.

## Runtime Contract

`DocumentSyncRuntime.sources` adds:

```ts
updatePolicy(input: {
  id: string;
  canUseForAnswering?: boolean;
  canUseForKnowledgeDrafts?: boolean;
}): Promise<DocumentSource | undefined>;
```

Behavior:

- Return `undefined` when the source does not exist.
- Apply `canUseForAnswering` first when present.
- Apply `canUseForKnowledgeDrafts` second when present.
- Return the source from the final applied update.
- If neither field is present, return the existing source.

The runtime checks existence with `findSourceById()` before applying updates so missing sources can map cleanly to HTTP 404 without relying on registry exceptions.

## HTTP API

### `PATCH /internal/document-sync/sources/:id/policy`

Request body:

```json
{
  "canUseForAnswering": false,
  "canUseForKnowledgeDrafts": true
}
```

Validation:

- `:id` must be a non-blank string.
- At least one policy field must be present.
- Present policy fields must be booleans.
- Unknown fields are ignored for v1.

Success:

```json
{
  "ok": true,
  "source": {}
}
```

Errors:

- `503 document_sync_worker_unavailable`
- `400 invalid_request`
- `404 document_source_not_found`
- `500 document_source_policy_update_failed`

## Architecture Notes

This belongs under `DocumentSyncRuntime.sources` because source policy is part of document source operations. Answer generation should only consume the resulting `canUseForAnswering` state and should not own policy mutation.

The endpoint deliberately does not include an actor id yet. Once admin authentication exists, the same route can attach actor metadata to a future audit log without changing the request shape.
