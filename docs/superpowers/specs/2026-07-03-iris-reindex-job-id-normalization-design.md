# Iris Reindex Job ID Normalization Design

## Problem

Reindex jobs use `embeddingProfileId` and `documentSnapshotId` for idempotency and
worker matching. The key helper and Redis parser currently preserve surrounding
whitespace, so a whitespace-padded id can create a different idempotency key or deserialize
into a job that later fails profile/snapshot matching.

## Decision

Normalize reindex job ids in two places:

- `createDocumentReindexIdempotencyKey` trims `embeddingProfileId` and
  `documentSnapshotId`.
- `parseDocumentReindexJob` trims parsed string fields via its local `readString` helper.

This mirrors the document sync and raw event id normalization rules already established
in the queue layer.

## Non-Goals

- Do not change reindex job reasons.
- Do not accept blank ids; trimmed blank values remain invalid.
- Do not change reindex DLQ replay/delete behavior.

## Quality Bar

- Whitespace-padded reindex idempotency key inputs produce the same key as normalized ids.
- Whitespace-padded Redis reindex payload ids parse to normalized jobs.
- Existing enqueue, retry, DLQ, replay, and delete behavior remains unchanged.
