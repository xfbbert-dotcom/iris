# Iris Worker Loop Snapshot Cloning Design

## Problem

Worker loop runtime snapshots are read by admin and observability surfaces. The
current `getSnapshot()` methods return the latest batch object directly, so a
caller can mutate dates or counters and corrupt the in-memory runtime view.

Phase 2B can stay in-memory for a 20-30 person initial rollout, but the exposed
state must still behave like a safe read model.

## Decision

Return cloned latest batch snapshots from every worker loop:

- `RawEventWorkerLoop`
- `DocumentSyncWorkerLoop`
- `DocumentReindexWorkerLoop`

Each clone must copy `startedAt` and `finishedAt` into new `Date` instances and
return a fresh object for both succeeded and failed batch variants.

## Non-Goals

- Do not change polling, retry, or timer behavior.
- Do not change worker result schemas.
- Do not change Feishu gateway acknowledgement semantics.

## Quality Bar

- Mutating a returned snapshot does not alter future snapshots.
- Date mutation on returned snapshots does not alter stored runtime state.
- Existing loop scheduling and batch counting behavior remains unchanged.
