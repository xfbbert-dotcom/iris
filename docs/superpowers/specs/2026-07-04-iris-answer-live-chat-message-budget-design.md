# Iris Answer Live Chat Message Budget Design

## Goal

Prevent oversized live-chat speaker or text values from bloating answer-draft dedupe and retrieval
context construction before prompt assembly applies its final budget.

## Architecture

Normalize live-chat messages inside `AnswerDraftOrchestrator` before deduplication:

- Speaker values are capped at `256` characters.
- Text values are capped at `2000` characters.
- Oversized values keep leading content and append ` ... [truncated]`.

This mirrors the prompt assembly budgets early enough that direct callers, stored chat context, and
request-supplied context cannot create oversized dedupe keys or oversized context-builder inputs.

## Invariants

- Blank speakers and texts are still filtered after trimming.
- Duplicate detection still runs on normalized speaker/text pairs.
- Prompt assembly keeps its XML escaping and attribute/body budgets.
- Stored recent message loading and request array limits are unchanged.

## Out Of Scope

- Changing the live-chat prompt budgets.
- Rejecting oversized live-chat messages instead of truncating them.
- Preserving full oversized chat text in answer context.
- Changing conversation fact-layer storage.
