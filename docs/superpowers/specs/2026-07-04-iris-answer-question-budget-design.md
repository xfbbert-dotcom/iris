# Iris Answer Question Budget Design

## Goal

Prevent direct orchestrator callers from bypassing the internal answer-draft API's question length
limit and sending oversized text into retrieval, embedding, or model calls.

## Architecture

`/internal/answer-drafts` already limits `question` to `4000` characters. The
`AnswerDraftOrchestrator` now enforces the same limit after trimming and before building retrieval
context.

This keeps future internal workers, tests, scripts, or admin tools safe even if they call the
orchestrator directly instead of going through Fastify request parsing.

## Invariants

- Blank questions still fail before retrieval.
- Valid questions at or below `4000` characters are unchanged.
- Fragment and live-chat limit validation remains unchanged.
- API request parsing keeps its existing `invalid_request` behavior for oversized questions.

## Out Of Scope

- Changing the `4000` character product limit.
- Truncating user questions automatically.
- Adding per-channel question limits.
- Changing model prompt wording.
