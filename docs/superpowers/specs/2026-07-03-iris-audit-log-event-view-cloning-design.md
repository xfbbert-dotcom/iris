# Iris Audit Log Event View Cloning Design

## Problem

`InMemoryAuditLog` clones events when recording them, but exposes the internal
`events` array directly. Callers can mutate returned events or `fragmentIds`, which
corrupts audit history and diagnostic metadata.

Audit history is part of the permission guard trust surface, so in-memory Phase 2B
state should be protected from external mutation.

## Decision

Store audit events in a private backing array and expose `events` through a getter
that returns cloned events:

- clone `recordedAt` as a new `Date`
- clone `fragmentIds`
- keep retention and summaries operating on the private backing array

## Non-Goals

- Do not change retention behavior.
- Do not add persistence.
- Do not change audit event schemas.

## Quality Bar

- Mutating a returned audit event does not change stored audit history.
- Mutating returned `fragmentIds` does not change stored audit history.
- Existing diagnostics and summary behavior remains unchanged.
