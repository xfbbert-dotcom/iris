# Iris Audit Summary Filters Design

## Goal

Make the internal audit summary useful during real operator triage. In a 20-30 person rollout, the likely workflow is direct: an operator sees one answer behaving oddly, knows the document or failure type, and needs a filtered view without scanning unrelated rows.

## Scope

This phase adds optional filters to the in-memory audit summary:

- `documentId`
- `type`

It does not add pagination, time ranges, durable storage, UI, or alerts. Those belong after the small-team version proves the core answer path and permission guard quality.

## API

`GET /internal/audit/events/summary?limit=20&documentId=source-1&type=permission_guard_denied`

`limit` still means "inspect the newest N retained audit events". Filters are applied inside that newest-event window. This keeps the endpoint cheap and consistent with the bounded in-memory model.

Invalid filters return `400 invalid_request`:

- blank `documentId`
- unknown `type`
- invalid `limit`

## Behavior

Filtering by both fields returns rows matching both `documentId` and `type`. Filtering by one field returns all matching summary rows within the selected recent event window.

The endpoint shape remains stable with Phase 4B:

- `documentId`
- `type`
- `eventCount`
- `affectedFragmentCount`
- `firstRecordedAt`
- `latestRecordedAt`

## Quality Bar

The filter path must be deterministic, covered by API and unit tests, and must not change how audit events are recorded. This is a read-side convenience for internal diagnosis, not a new source of truth.
