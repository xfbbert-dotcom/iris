# Iris Answer Live Chat Array Budget Design

## Goal

Prevent direct answer-draft orchestrator callers from bypassing the internal API's request
live-chat array limit.

## Architecture

`/internal/answer-drafts` already rejects request-supplied `liveChatMessages` arrays above `50`
items. The `AnswerDraftOrchestrator` now enforces the same limit before loading stored chat context,
deduplicating messages, building retrieval context, embedding, or calling the model.

This keeps future internal workers, scripts, tests, and admin tools aligned with the HTTP API
boundary.

## Invariants

- Stored live-chat context loading remains capped separately by `liveChatLimit` and the provider's
  `20` message maximum.
- Valid request arrays at or below `50` messages are unchanged.
- Blank/duplicate message normalization still happens after stored context is loaded.
- API request parsing keeps its existing `invalid_request` behavior.

## Out Of Scope

- Changing the `50` message request limit.
- Per-message speaker/text truncation in the orchestrator.
- Changing prompt assembly's latest-20 live-chat anchor.
- Changing stored live-chat loading behavior.
