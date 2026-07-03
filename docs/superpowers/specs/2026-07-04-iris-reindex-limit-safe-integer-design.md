# Iris Reindex Limit Safe Integer Design

## Context

Manual profile reindexing accepts a numeric `limit` that controls how many
snapshots are inspected and enqueued for semantic indexing. JavaScript cannot
represent integers beyond `Number.MAX_SAFE_INTEGER` exactly, so accepting unsafe
limits can distort operator intent before the value reaches storage planning.

## Decision

The internal reindex API must reject unsafe integer limits with `400
invalid_request`. The reindex planner also sanitizes unsafe limits to zero so
direct runtime usage cannot bypass the API boundary.

## Consequences

- Operator requests with unsafe limits cannot trigger ambiguous reindex plans.
- Planner-level defense keeps dependency-injected runtime calls bounded even
  outside HTTP request handling.
- Existing valid positive integer limits keep their current behavior.

