# Iris Answer Language Style Prompt Design

## Context

Iris will first be used by a 20-30 person Chinese-speaking company team inside Feishu groups.
The current answer model system prompt identifies Iris and tells the model to use safe context, but
it does not explicitly tell the model to answer in the user's language. In Chinese group chats, that
can produce English or mixed-language replies even when the question and live context are Chinese.

## Decision

Add a compact language-style instruction to the answer draft system prompt:

- answer in the same language as the user's question and live chat context;
- default to concise, natural Chinese when the language is unclear;
- keep replies direct and useful for an internal work chat.

This keeps the change at the model boundary and does not alter retrieval, permission filtering,
message routing, or Feishu reply dispatch.

## Invariants

- Permission and context-safety instructions remain present.
- Prompt size stays bounded by the existing model provider budgets.
- The provider still supports non-Chinese questions by asking for same-language answers.

## Out Of Scope

- Adding per-tenant language settings.
- Changing answer formatting, markdown policy, or citation behavior.
- Changing fallback clarification messages in `FeishuMentionAnswerResponder`.
