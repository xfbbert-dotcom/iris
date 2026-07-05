# Iris Feishu Message Content Budget Implementation Plan

## Goal

Prevent oversized Feishu `message.content` JSON strings from being parsed by the
event worker before any size budget applies.

## Architecture

Keep the budget at the message parsing boundary inside
`FeishuMessageEventProcessor`. The Feishu Gateway remains ack-first, and the raw
event queue remains responsible for durable ingestion and idempotency. Oversized
content is treated as unreadable message text rather than as a failed event.

## Steps

- [x] Add failing coverage for an oversized Feishu text content payload.
- [x] Guard `message.content` length before `JSON.parse`.
- [x] Confirm normal extracted-text truncation still works.
- [x] Update the architecture whitepaper with the pre-parse content budget rule.

## Verification

- `npm --workspace apps/core run test -- tests/feishu-message-event-processor.test.ts`
