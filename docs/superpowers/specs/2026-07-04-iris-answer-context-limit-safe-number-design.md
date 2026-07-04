# Iris Answer Context Limit Safe Number Design

## Context

The internal answer draft API accepts optional `fragmentLimit` and
`liveChatLimit` values. These values shape retrieved background documents and
the live chat context sent to the model. Lower layers cap and floor safe finite
numbers, but the API boundary previously allowed values outside JavaScript's
safe integer range.

## Decision

The answer draft API must reject non-finite or unsafe-magnitude context limits
before calling the orchestrator. The orchestrator must reject unsafe-magnitude
limits before loading stored live chat context or building prompt context.
Retrieval context building, prompt assembly, live-chat context providers, and
conversation-message storage adapters must also reject unsafe-magnitude limits
when called directly, so future internal callers cannot silently normalize
ambiguous values into valid prompt budgets or SQL limits. Existing behavior for
finite safe fractional or negative values is preserved, because downstream
context assembly already floors and clamps them.

## Consequences

- Malformed context-window requests fail before model orchestration.
- Direct orchestrator calls fail before live-chat history reads when context
  limits have unsafe numeric magnitude.
- Large unsafe values cannot be silently normalized into a valid prompt budget.
- Large unsafe values cannot reach conversation-message storage as SQL `LIMIT`
  values.
- Lower-level context builders keep their defensive caps for safe finite direct
  caller values.
