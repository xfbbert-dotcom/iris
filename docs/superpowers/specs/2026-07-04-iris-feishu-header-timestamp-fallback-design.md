# Iris Feishu Header Timestamp Fallback Design

## Context

Conversation message ordering depends on accurate `sentAt` values. The Feishu
message fact-store design already requires timestamp extraction to prefer
`event.message.create_time`, then `header.create_time`, and only then
`RawEvent.receivedAt`. The implementation only used the message timestamp before
falling back to receive time.

## Decision

Feishu message parsing must use the header timestamp as the second fallback when
the message-level timestamp is missing, blank, non-finite, or otherwise
unparseable.

## Consequences

- Stored live-chat context keeps closer chronological ordering when Feishu omits
  or corrupts the message-level timestamp but still provides a valid header
  timestamp.
- Invalid header timestamps remain safe because parsing falls back to
  `RawEvent.receivedAt`.
