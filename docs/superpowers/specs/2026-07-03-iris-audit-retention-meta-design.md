# Iris Audit Retention Metadata Design

## Goal

Make Iris audit diagnostics honest about the limits of the v1 in-memory audit log. Operators should know whether they are seeing the complete retained window or whether older events have already been dropped.

## Scope

This phase adds retention metadata to the in-memory audit log and to internal audit read endpoints:

- `maxEventCount`
- `retainedEventCount`
- `droppedEventCount`

It does not add durable audit storage or change the retention policy. Postgres-backed audit history remains a later phase.

## Behavior

`InMemoryAuditLog` increments `droppedEventCount` whenever recording a new event causes old events to be trimmed. The counter is process-local and resets on restart, matching the current in-memory model.

Both internal audit endpoints include retention metadata in their existing `meta` block:

- `GET /internal/audit/events`
- `GET /internal/audit/events/summary`

This lets an operator distinguish:

- no audit history exists
- audit history exists but the query window is small
- audit history exists but older events have been dropped

## Quality Bar

The change must be read-side diagnostic metadata only. It must not affect permission guard behavior, answer generation, Feishu ingestion, or event recording semantics beyond counting dropped retained events.
