# Iris Prompt Escaped Text Budget Design

## Context

Iris assembles answer context with XML-like tags:

- `<background_documents>` for retrieved document evidence;
- `<live_chat_context>` for recent group conversation.

Per-item raw text budgets already existed for background documents and live chat messages. However, XML escaping happens after trimming and can expand characters such as `&`, `<`, `>`, and quotes. A chat message or document fragment full of log output, pasted HTML, code, or malformed text can therefore exceed the intended prompt budget after formatting.

For a small internal rollout, this matters because users will paste real engineering and design context into Feishu. Iris should answer gracefully instead of failing the model request because one pasted message expanded during escaping.

## Decision

`assemblePromptContext` now bounds text after XML escaping:

- background document text stays within `1200` escaped characters;
- live chat message text stays within `2000` escaped characters.

When escaped text would exceed the budget, Iris binary-searches the longest raw prefix that fits after escaping and appends ` ... [truncated]` inside the same escaped-output budget.

## Scope

- Does not change prompt section order.
- Does not change live chat or document retrieval counts.
- Does not mutate stored messages or document fragments.
- Does not change XML attribute budgeting, which was already escaped-output aware.

## Quality Bar

- Repeated XML-sensitive characters cannot make one background document exceed its final XML text budget.
- Repeated XML-sensitive characters cannot make one live chat message exceed its final XML text budget.
- Truncation remains visible to the model.
- Normal short text remains unchanged except for trimming and XML escaping.
