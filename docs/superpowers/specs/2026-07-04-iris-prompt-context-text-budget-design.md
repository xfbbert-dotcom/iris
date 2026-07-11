# Iris Prompt Context Text Budget Design

## Goal

Prevent one oversized live chat message or retrieved document fragment from dominating the prompt
context passed to the model.

## Architecture

`assemblePromptContext` remains the final prompt assembly boundary. It still places
`<background_documents>` before `<live_chat_context>` so live chat remains the closest context to
the model output. It applies per-item text budgets to the escaped XML text that will actually enter
the final prompt:

- Background document text: `1200` characters.
- Live chat message text: `2000` characters.

When escaped text exceeds its budget, Iris keeps the leading content and appends
` ... [truncated]` within the same escaped-output budget. The marker makes the loss visible to the
model without changing retrieval, permission checks, live chat ordering, or message persistence.

## Invariants

- Live chat context remains last in the prompt.
- Existing item count limits remain unchanged: latest `20` live chat messages and first `12`
  background documents.
- Blank filtering and XML escaping still happen.
- Escaping expansion from repeated `&`, `<`, `>`, or quotes cannot make a single item exceed its
  final XML text budget.
- Truncation applies at prompt assembly time only; stored messages and document fragments are not
  mutated.
- The returned prompt never includes the omitted tail of an oversized item.

## Out Of Scope

- Dynamic token counting by model.
- Changing document chunking, retrieval limits, or live chat loading limits.
- Truncating stored conversation messages.
- Summarizing the omitted tail.
