# Iris Answer Draft Request Budget Design

## Goal

Prevent oversized internal answer draft requests from reaching retrieval, embedding, or model
generation.

## Architecture

`parseAnswerDraftRequest` is the API boundary for `/internal/answer-drafts`. It now validates:

- `question`: non-blank string with a maximum of `4000` characters.
- `liveChatMessages`: array with a maximum of `50` items.

The downstream answer orchestrator and prompt assembly keep their existing behavior. Prompt assembly
still limits the final live chat context to the latest `20` meaningful messages, but the API rejects
pathologically large arrays before mapping every item. A `4000` character question budget keeps
detailed user asks possible while preventing oversized embedding/model provider calls.

## Invariants

- Blank questions still return `400 invalid_request`.
- Valid optional `chatId`, `fragmentLimit`, and `liveChatLimit` behavior is unchanged.
- The answer orchestrator is not called for oversized questions or oversized live chat arrays.
- Stored group context loading and final prompt live chat limits remain unchanged.

## Out Of Scope

- Dynamic token counting by provider/model.
- Changing the answer orchestration query strategy.
- Truncating questions instead of rejecting them.
- Changing per-message prompt text truncation.
