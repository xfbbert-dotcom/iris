# Iris Answer Context Limit Safe Number Design

## Context

The internal answer draft API accepts optional `fragmentLimit` and
`liveChatLimit` values. These values shape retrieved background documents and
the live chat context sent to the model. Lower layers cap and floor safe finite
numbers, but the API boundary previously allowed values outside JavaScript's
safe integer range.

## Decision

The answer draft API must reject non-finite or unsafe-magnitude context limits
before calling the orchestrator. Retrieval context building and prompt assembly
must also reject unsafe-magnitude limits when called directly, so future
internal callers cannot silently normalize ambiguous values into valid prompt
budgets. Existing behavior for finite safe fractional or negative values is
preserved, because downstream context assembly already floors and clamps them.

## Consequences

- Malformed context-window requests fail before model orchestration.
- Large unsafe values cannot be silently normalized into a valid prompt budget.
- Lower-level context builders keep their defensive caps for safe finite direct
  caller values.
