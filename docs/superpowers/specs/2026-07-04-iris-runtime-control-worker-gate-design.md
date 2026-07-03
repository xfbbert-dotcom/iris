# Iris Runtime Control Worker Gate Design

## Problem

The Feishu Gateway now skips enqueueing new events for disabled scopes, but
events that were already queued before an administrator disabled Iris can still
be processed by the event worker. That can write message facts and discover
documents after the scope is disabled.

## Decision

Pass the shared `RuntimeController` gate into Feishu message processing:

- `buildApp()` passes its runtime controller to the default event worker runtime.
- `createEventWorkerRuntime()` passes the gate to `createFeishuMessageEventProcessor()`.
- `createFeishuMessageEventProcessor()` parses the message first, then skips
  persistence and document discovery if the parsed `chatId` is disabled.

## Non-Goals

- Do not purge existing Redis queue entries in this patch.
- Do not add persistent runtime-control state.
- Do not change retry or dead-letter semantics for skipped disabled messages.

## Quality Bar

- Disabled queued group messages do not upsert conversation memory.
- Disabled queued group messages do not register discovered document links.
- Enabled groups continue through the existing processing path.
