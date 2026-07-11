# Iris Conversation Message ID Budget Design

## Goal

Prevent oversized conversation message identifiers from reaching Postgres writes, indexes, or
recent-chat reads when callers bypass the Feishu event normalizer.

## Architecture

The Postgres conversation message repository now applies a `512` character maximum to direct
identifier-like inputs before issuing SQL:

- `providerMessageId`
- `chatId`
- `senderId`
- `messageType`
- `rawEventIdempotencyKey`

The same `chatId` budget is applied to `listRecentByChat` before querying Postgres.
All identifier-like values must also be non-blank after trimming. Blank values are rejected before
SQL execution rather than being normalized into a possibly misleading provider id.

The Feishu message event processor applies the same `512` character budget to required incoming
message identifiers before writing facts. Oversized required message IDs, chat IDs, or message types
are treated as unsupported external events. Oversized optional sender identifiers are omitted so a
malformed sender field does not poison an otherwise valid group message fact.

## Invariants

- Valid conversation message writes are unchanged.
- Identifiers are rejected, not truncated, so idempotency keys and provider IDs stay exact.
- Blank identifiers are rejected before any Postgres query is attempted.
- Rejected oversized values fail before any Postgres query is attempted.
- Oversized required Feishu message identifiers are dropped at the processor boundary to avoid
  retrying malformed external events into dead letters.
- Oversized optional Feishu sender identifiers are omitted rather than persisted.
- Message text continues to use the existing `8000` character truncation budget.
- Legacy oversized message text is still bounded while reading rows.

## Out Of Scope

- Changing Feishu raw event retention.
- Changing the `conversation_messages` database schema.
- Truncating provider IDs, chat IDs, sender IDs, message types, or idempotency keys.
- Changing prompt assembly budgets for live-chat context.
