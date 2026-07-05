# Iris Feishu Message Content Budget Design

Date: 2026-07-05

## Context

Feishu message events carry `message.content` as a JSON string. Iris already
truncates extracted message text to 8,000 characters and bounds post-message
tree traversal, but parsing the raw `content` string still happened before any
content-size guard. A malformed or unusually large group message could therefore
force the event worker to parse a large JSON payload before the existing text
budget applied.

## Decision

`FeishuMessageEventProcessor` must reject oversized `message.content` strings
before `JSON.parse`.

- The maximum accepted content JSON string is 64,000 characters.
- Oversized content is treated like malformed or unsupported content: Iris still
  records the message metadata, but `text` is `undefined`.
- Downstream document-link extraction receives no text for oversized content, so
  document discovery cannot be triggered by an over-budget payload.
- Mention handling still receives the parsed message metadata and mentions, but
  the message text is absent.
- The legacy `normalizeFeishuEvent` compatibility path applies the same content
  budget before parsing. Because its normalized group-message shape requires
  `text`, over-budget content is returned as `unsupported` instead of emitting a
  giant text event.

## Rationale

The 64k budget is comfortably above ordinary Feishu text and rich-text group
messages for the initial 20-30 person deployment, while preventing one unusually
large message body from monopolizing a worker. Keeping the message fact without
text preserves observability and chronology without trusting an over-budget
content body.

## Non-Goals

- This does not reject the whole Feishu callback at the gateway.
- This does not change raw event queue serialization or idempotency.
- This does not change the 8,000-character extracted message text budget.
- This does not add file/PDF body parsing to group message ingestion.

## Tests

- Oversized text content JSON is persisted as a message fact with `text`
  undefined.
- Oversized content does not reach document-link extraction.
- Existing oversized extracted text still truncates to 8,000 characters when the
  content JSON itself is within budget.
- Legacy event normalization rejects oversized content before link extraction.
