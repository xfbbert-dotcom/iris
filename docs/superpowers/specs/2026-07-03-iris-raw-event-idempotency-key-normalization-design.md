# Iris Raw Event Idempotency Key Normalization Design

## Problem

`createRawEventIdempotencyKey` builds stable queue keys from provider event ids, but it
uses the raw `eventId` string. The Feishu gateway currently normalizes event ids before
calling it, but the helper is public and future callers could pass whitespace-padded ids,
creating duplicate raw event keys for the same provider event.

## Decision

Trim `eventId` inside `createRawEventIdempotencyKey`.

The helper remains intentionally small. It only normalizes the id string used to form the
idempotency key; validation stays at the caller boundary.

## Quality Bar

- Whitespace-padded raw event ids produce the same idempotency key as normalized ids.
- Existing raw event queue deduplication behavior remains unchanged.
