# Iris Retrieval Query Budget Design

## Goal

Prevent direct document-retrieval callers from sending oversized query text into the embedding
provider or vector search path.

## Architecture

`AnswerDraftOrchestrator` already limits user questions to `4000` characters before retrieval.
`DocumentRetrievalContextBuilder` now enforces the same query-text budget at its own boundary.

This keeps future workers, admin scripts, tests, or internal services safe even if they call the
retrieval builder directly instead of going through answer-draft orchestration.

## Invariants

- Valid query text at or below `4000` characters is unchanged.
- Oversized query text is rejected before embedding or vector search.
- Fragment limit validation and candidate overfetching remain unchanged.
- Prompt assembly still owns final XML escaping and prompt-context budgets.

## Out Of Scope

- Changing the `4000` character product limit.
- Truncating retrieval queries automatically.
- Adding per-channel retrieval query limits.
- Changing embedding provider batching or model prompt wording.
