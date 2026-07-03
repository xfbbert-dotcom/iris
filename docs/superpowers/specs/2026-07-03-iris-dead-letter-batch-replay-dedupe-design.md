# Iris Dead Letter Batch Replay Dedupe Design

## Context

Admin tooling can send duplicate dead-letter ids in a batch replay request, either through repeated selection or client retries. Replaying the same id twice in one request produced confusing results: in-memory queues reported the second occurrence as not found, and Redis-backed tests could perform duplicate replay operations.

## Decision

Each dead-letter batch replay method deduplicates ids within the request while preserving first-seen order.

## Scope

- Applies to document sync and document reindex queues.
- Applies to both in-memory and Redis queue implementations.
- Does not change single-item replay behavior.
- Does not change API request shape or maximum batch size.

## Quality Bar

- Repeated ids in one batch are replayed at most once.
- Duplicate ids do not appear in `notFoundIds` after the first occurrence succeeds.
- Redis replay side effects run once per unique id.
