# Iris Audit Event Filters Design

## Goal

Let internal operators move from a summarized permission problem to the raw audit events behind it. The small-team rollout needs fast diagnosis more than a large observability system, so the raw event endpoint should support the same narrow filters as the summary endpoint.

## Scope

This phase adds optional filters to `GET /internal/audit/events`:

- `documentId`
- `type`

It does not add paging cursors, time ranges, durable audit storage, or a UI. It stays within the bounded in-memory audit model.

## API

`GET /internal/audit/events?limit=20&documentId=source-1&type=permission_guard_denied`

`limit` selects the newest retained event window first. Filters are then applied inside that window. Results remain newest-first.

Invalid filters return `400 invalid_request`:

- blank `documentId`
- unknown `type`
- invalid `limit`

## Behavior

The raw event and summary endpoints now share the same filter semantics. This keeps operator workflows predictable:

1. Use `/internal/audit/events/summary` to find repeated document/type problems.
2. Use `/internal/audit/events` with the same filters to inspect raw event details and messages.

## Quality Bar

This feature must not affect audit recording, answer generation, or Feishu ingestion. It is a read-side diagnostic improvement only.
