# Iris Document Sync Idempotency Key Normalization Design

## Problem

`createDocumentSyncIdempotencyKey` builds stable sync queue keys from `documentSourceId`, but it currently uses the raw string. If a caller passes an id with surrounding whitespace, Iris can enqueue duplicate sync jobs for the same source.

## Decision

Trim `documentSourceId` inside `createDocumentSyncIdempotencyKey`.

The function remains intentionally small: it does not validate source existence, it only normalizes the id string used to form the idempotency key.

## Quality Bar

- Whitespace-padded ids produce the same idempotency key as normalized ids.
- Existing queue deduplication behavior remains unchanged.
