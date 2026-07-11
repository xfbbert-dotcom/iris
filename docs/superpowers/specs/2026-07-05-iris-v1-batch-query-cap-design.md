# Iris v1 Batch And Query Cap Design

## Context

Iris v1 is intended for an internal 20-30 person rollout, but the core
collaboration paths must remain reliable under accidental operator input,
platform retries, active group chats, and direct module calls from future
runtime wiring. Several layers already rejected unsafe integers, but direct
safe finite limits above normal page sizes could still ask queues or storage
adapters to process more work than a v1 operator surface needs.

## Decision

For v1, Iris uses `100` as the default hard cap for broad batch/list/query
surfaces that are not part of the LLM prompt budget:

- internal admin list/query parsing;
- raw event, document sync, and reindex queue `dequeueBatch()` calls;
- raw event, document sync, and reindex DLQ list calls;
- document sync runtime source and snapshot lists;
- audit summary windows;
- direct conversation-history, semantic fragment-search, and missing-profile
  snapshot storage queries.

Smaller domain caps still win where context quality matters more than operator
page size. Answer-time live chat, prompt assembly, retrieval candidate
overfetching, document chunk text, model output, and Feishu payload budgets keep
their own stricter limits.

## Consequences

- A safe but oversized direct-call limit is capped before queue consumption,
  Redis `lPop`/`lRange`, or SQL/vector query execution.
- Non-finite direct-call values keep defensive empty-result behavior where that
  behavior already existed.
- Unsafe integers are still rejected before work is consumed.
- Operators keep predictable v1 page sizes, while the product remains easy to
  loosen later if real internal usage demands it.
- Raising broad caps above `100` should be treated as an architecture change,
  because it affects operator UX, storage cost, and abuse resistance.
