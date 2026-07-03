# Iris Answer Draft Live Chat Dedup Design

## Problem

When a request supplies `chatId`, Iris loads stored live chat context and then appends live messages supplied by the current request. During Feishu retries or local internal API calls, the same message can appear in both sources.

Duplicated live chat context wastes prompt space and can make recent conversation look more important than it is.

## Decision

Deduplicate live chat messages inside `AnswerDraftOrchestrator` after stored and request messages are combined.

Two messages are considered duplicates when both `speaker` and `text` match exactly. The first occurrence is kept so stored chronological context remains stable, and later duplicates are skipped.

## Quality Bar

- Deduplication happens before `contextBuilder.buildContext`.
- The model still receives the same prompt assembled by the context builder.
- The behavior is covered by an orchestrator test.
