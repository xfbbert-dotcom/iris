# Iris Answer Draft Live Chat Dedup Design

## Problem

When a request supplies `chatId`, Iris loads stored live chat context and then appends live messages supplied by the current request. During Feishu retries or local internal API calls, the same message can appear in both sources.

Duplicated live chat context wastes prompt space and can make recent conversation look more important than it is.

## Decision

Deduplicate live chat messages inside `AnswerDraftOrchestrator` after stored and request messages are combined.

Two messages are considered duplicates when both `speaker` and `text` match exactly. The newest occurrence is kept so a repeated current message cannot be displaced by an older stored copy. The remaining messages keep chronological order.

## Quality Bar

- Deduplication happens before `contextBuilder.buildContext`.
- Deduplication happens before the live chat context window is selected, and the newest duplicate survives the window.
- The model still receives the same prompt assembled by the context builder.
- The behavior is covered by an orchestrator test.
