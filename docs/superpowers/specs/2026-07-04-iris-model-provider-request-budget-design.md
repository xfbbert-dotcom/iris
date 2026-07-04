# Iris Model Provider Request Budget Design

## Goal

Prevent direct model provider callers from sending oversized answer-draft requests to an external
OpenAI-compatible chat completions API.

## Architecture

`AnswerDraftOrchestrator` already limits questions to `4000` characters and prompt assembly bounds
document and live-chat context before model generation. The OpenAI-compatible model provider now
adds a final request-body guard:

- `question` must be at most `4000` characters.
- `promptContext` must be at most `80000` characters.

The prompt-context ceiling is intentionally above the current context-builder output envelope, so
normal answer generation remains unchanged while direct provider misuse fails before fetch.

## Invariants

- Valid model requests within budget are unchanged.
- Oversized questions or prompt contexts are rejected before timeout setup, fetch, or response
  parsing.
- Existing response JSON parsing, finish-reason rejection, and external error-message truncation
  remain unchanged.
- Orchestrator and context assembly keep their own earlier, tighter product-level budgets.

## Out Of Scope

- Changing prompt assembly budgets.
- Adding token counting or provider-specific model-window detection.
- Automatically truncating model requests at the provider boundary.
- Changing model temperature, system prompt, or retry behavior.
