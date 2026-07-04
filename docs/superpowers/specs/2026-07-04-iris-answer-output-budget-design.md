# Iris Answer Output Budget Design

## Goal

Prevent oversized model answers from flooding Iris API responses or downstream Feishu replies.

## Architecture

Apply the answer-text budget in `AnswerDraftOrchestrator`, after the model provider returns and
before the answer draft result is exposed to callers. This keeps the boundary independent of the
specific model provider implementation.

The orchestrator:

- Trims model output.
- Rejects blank output as before.
- Caps returned `answerText` at `8000` characters.
- Appends ` ... [truncated]` when the cap is applied.

## Invariants

- Prompt construction and document retrieval behavior are unchanged.
- Short model answers remain unchanged except for trimming.
- Blank model answers still fail with `model answer draft must not be blank`.
- Retrieved fragment metadata remains unchanged.
- Provider-specific response parsing, timeout handling, and finish-reason checks remain unchanged.

## Out Of Scope

- Adding provider-specific `max_tokens` configuration.
- Splitting long answers into multiple Feishu messages.
- Summarizing oversized answers with a second model call.
- Changing answer style, persona, or citation behavior.
