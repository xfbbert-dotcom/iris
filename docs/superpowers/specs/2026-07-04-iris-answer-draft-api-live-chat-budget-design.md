# Iris Answer Draft API Live Chat Budget Design

## Goal

Prevent oversized manually supplied live-chat context from reaching the answer draft orchestrator
through the internal API.

## Architecture

The `/internal/answer-drafts` request parser now normalizes live-chat message fields before calling
the orchestrator:

- `liveChatMessages[].speaker` is trimmed and truncated to `256` characters.
- `liveChatMessages[].text` is trimmed and truncated to `2000` characters.
- Oversized fields keep the standard ` ... [truncated]` marker.

This mirrors the existing answer draft orchestrator and prompt assembly budgets, but applies the
budget earlier at the API boundary.

## Invariants

- Blank live-chat speakers or text still make the request invalid.
- The API still accepts up to `50` manually supplied live-chat messages.
- Oversized live-chat fields are truncated, not rejected, preserving the current tolerant answer
  draft behavior.
- Question, chat ID, and context-limit validation are unchanged.
- The orchestrator remains a second defensive boundary for non-API callers.

## Out Of Scope

- Changing prompt assembly ordering or XML tags.
- Changing stored group live-chat retrieval.
- Changing answer draft model provider request budgets.
- Changing the public response schema.
