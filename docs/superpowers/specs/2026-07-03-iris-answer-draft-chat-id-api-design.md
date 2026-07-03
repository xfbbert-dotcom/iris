# Iris Answer Draft Chat ID API Design

## Problem

The answer draft orchestrator supports an optional `chatId` so it can load stored live chat
context before answering. The `/internal/answer-drafts` API parser did not accept or pass
`chatId`, so API callers had to send all live chat messages explicitly.

That works against the core Iris experience: a group bot should be able to answer from the
conversation context it has already stored.

## Decision

Allow `/internal/answer-drafts` requests to include optional `chatId`:

- Trim `chatId`.
- Reject blank `chatId` if the field is provided.
- Pass normalized `chatId` to the orchestrator.

Existing `liveChatMessages` remains required as an array, even when empty, to keep the API
shape explicit and backward compatible.

## Non-Goals

- Do not make `liveChatMessages` optional in this patch.
- Do not change stored live chat retrieval limits.
- Do not expose a public bot endpoint in this patch.
- Do not change answer draft error responses.

## Quality Bar

- `chatId: " oc_1 "` reaches the orchestrator as `chatId: "oc_1"`.
- Blank `chatId` returns `400 invalid_request`.
- Existing answer draft requests continue to work.
