# Iris Live Chat Normalized Dedupe Design

## Problem

The answer draft orchestrator merges stored live chat context with request-provided live
chat context, then deduplicates by raw `speaker` and `text` values. If two messages differ
only by surrounding whitespace, both survive dedupe and can later render as duplicate
prompt messages after context assembly trims them.

## Decision

Normalize live chat messages inside `dedupeLiveChatMessages` before building the dedupe
key:

- Trim `speaker`.
- Trim `text`.
- Drop messages that become blank after trimming.
- Keep the first normalized message for each `speaker + text` pair.

This keeps the orchestrator defensive even when called directly from tests or future
internal entrypoints, while preserving existing request parser and live chat provider
validation.

## Non-Goals

- Do not perform semantic dedupe or fuzzy matching.
- Do not collapse repeated messages with different speakers.
- Do not change stored-message loading order.
- Do not change live chat limit behavior.

## Quality Bar

- Stored and request messages that only differ by surrounding whitespace dedupe to one
  prompt candidate.
- The message passed to context building is trimmed.
- Existing exact-match dedupe behavior remains intact.
- Blank normalized messages cannot enter context building through this helper.
