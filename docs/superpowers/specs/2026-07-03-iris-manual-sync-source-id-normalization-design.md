# Iris Manual Sync Source ID Normalization Design

## Problem

`ManualDocumentSyncPlanner` accepts `documentSourceId` and uses it directly for lookup and queue idempotency keys. If callers pass a valid id with surrounding whitespace, the planner returns `not_found` even though the source exists.

The API layer should validate requests, but the planner is a core domain boundary and should normalize simple string identity itself.

## Decision

Trim `documentSourceId` at the start of `enqueueSource`.

All subsequent lookup, state mutation, queue job fields, and return payloads use the trimmed id.

If the trimmed id is empty, the planner returns `not_found` without enqueueing.

## Quality Bar

- Whitespace-padded ids resolve to the existing source.
- Queue jobs use the normalized id.
- Unknown and blank ids do not enqueue.
