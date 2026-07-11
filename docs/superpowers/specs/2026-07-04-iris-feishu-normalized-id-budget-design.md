# Iris Feishu Normalized ID Budget Design

## Goal

Prevent oversized Feishu identifiers from entering normalized group-message events and downstream
conversation or document-registration paths.

## Architecture

The Feishu event normalizer now applies a `512` character maximum to identifier fields before it
returns a `group_message` event:

- `event_id`
- `message.message_id`
- `message.chat_id`
- `sender.sender_id.open_id`

Oversized required identifiers are treated like missing required fields, so the event becomes
`unsupported` and does not enter message storage, document link registration, or answer-time live
chat context.

## Invariants

- Valid Feishu message events are unchanged.
- Missing required fields still return `missing_required_fields`.
- Oversized optional/top-level `event_id` falls back to `unknown` for unsupported-event metadata.
- Text parsing, timestamp parsing, and document-link extraction remain unchanged.

## Out Of Scope

- Changing raw event storage, which intentionally preserves original Feishu payloads.
- Truncating oversized Feishu identifiers.
- Adding per-provider ID budgets outside the Feishu normalizer.
- Changing conversation message text budgets.
