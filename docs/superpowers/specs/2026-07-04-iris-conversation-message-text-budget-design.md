# Iris Conversation Message Text Budget Design

## Goal

Prevent oversized Feishu chat messages from bloating the conversation fact layer.

## Architecture

Apply a storage/read budget in `PostgresConversationMessageRepository`, the durable fact-layer
boundary for conversation messages.

The repository:

- Caps stored message `text` at `8000` characters.
- Appends ` ... [truncated]` when the cap is applied.
- Applies the same cap when mapping rows so legacy oversized values cannot bloat callers.

This keeps full raw event payload retention in the raw-event queue unchanged while bounding the
conversation fact used by live-chat context and future memory surfaces.

## Invariants

- Message IDs, chat IDs, sender IDs, message types, timestamps, and raw event idempotency keys are
  unchanged.
- Messages without text still store `null` and read as `undefined`.
- Recent-message ordering and limit handling are unchanged.
- Prompt assembly keeps its separate, smaller live-chat context budget.

## Out Of Scope

- Truncating raw Feishu event payloads.
- Changing document link extraction behavior.
- Adding a database column length constraint.
- Summarizing oversized chat messages.
