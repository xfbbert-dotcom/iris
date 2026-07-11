# Iris Live Chat Context Scan Backfill Design

Date: 2026-07-05
Status: Focused hardening patch for Iris v1 answer quality

## Goal

Keep Iris's recent group-chat context useful when the newest messages include images, blank text, or
other non-text events.

## Problem

The live-chat context provider previously queried exactly the number of messages it planned to pass
to the prompt. It then filtered out non-text and blank messages. In active Feishu groups, the latest
20 raw messages can include screenshots, docs, stickers, or malformed text events, which means Iris
may enter answer generation with far fewer than 20 useful text turns even though older text context
is available.

## Design

Separate the repository scan window from the prompt output window:

- the prompt output window remains capped at 20 messages;
- the repository scan window is `outputLimit * 3`, capped at 100 raw messages;
- after scanning, Iris keeps only non-blank text messages, preserves chronological order, and returns
  the latest `outputLimit` text messages;
- when the output limit is zero, the provider returns an empty list without querying the repository.

This keeps the model context budget stable while improving recall of recent human discussion.

## Scope

In scope:

- update `LiveChatContextProvider` scan semantics;
- add focused tests for text backfill, scan-window expectations, and zero-limit behavior.

Out of scope:

- changing the answer prompt live-chat cap;
- changing conversation-message persistence or Postgres ordering;
- adding semantic ranking for chat messages.

## Testing

Run `npm --workspace apps/core run test -- tests/live-chat-context-provider.test.ts` and full
`npm run verify`.
