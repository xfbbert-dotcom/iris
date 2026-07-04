# Iris Worker Job ID Budget Design

## Goal

Prevent oversized or inconsistent document sync and document reindex queue job identifiers from
entering workers.

## Architecture

Document sync and document reindex job identifiers now use a `512` character maximum for each
identifier component:

- document sync `documentSourceId`
- document reindex `embeddingProfileId`
- document reindex `documentSnapshotId`

Queue parsers also validate that the stored `idempotencyKey` exactly matches the canonical key
recomputed from the parsed and bounded fields:

- `document-sync:<documentSourceId>`
- `reindex:<embeddingProfileId>:<documentSnapshotId>`

Invalid queued payloads continue to be rejected as invalid job payloads and are moved to DLQ by the
existing dequeue logic.

## Invariants

- Existing valid queue jobs round-trip unchanged.
- Legacy jobs without `attempts` still default to `0`.
- Job creator helpers reject oversized IDs before queue enqueue.
- Parser validation rejects mismatched idempotency keys and oversized queued IDs.
- Queue retry, replay, delete, and DLQ behavior stay unchanged for valid jobs.

## Out Of Scope

- Changing Redis key names or Lua scripts.
- Changing worker batch limits.
- Changing document source or snapshot database schemas.
- Adding migration-time cleanup for existing polluted queue entries.
