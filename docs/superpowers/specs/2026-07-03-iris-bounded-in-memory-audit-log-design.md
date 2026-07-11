# Iris Bounded In-Memory Audit Log Design

## Context

Iris now exposes recent in-memory audit events. The current `InMemoryAuditLog` stores every event forever, which is fine for tests but unsafe for a long-running internal service.

For a 20-30 person first rollout, a bounded in-memory log is enough. Operators need recent troubleshooting evidence, not unlimited audit retention.

## Goal

Make `InMemoryAuditLog` retain only the newest N events.

## Behavior

- Default retention is 1000 events.
- Callers may pass `{ maxEvents }` for tests or specialized local use.
- `maxEvents` must be a positive integer.
- When recording over capacity, the oldest events are discarded.
- Event order remains oldest-to-newest inside `events`, so existing `GET /internal/audit/events` can keep reversing the latest slice.

## Non-Goals

- No persistent audit storage.
- No environment variable for retention yet.
- No per-event timestamps in this phase.

## Testing

Add focused unit tests for:

- default construction;
- rejecting invalid `maxEvents`;
- retaining only the newest events when capacity is exceeded.
