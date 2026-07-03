# Iris Snapshot Repository Context Design

## Context

The document snapshot repository is injected into sync, reindex, and retrieval flows. Its `findLatestSnapshotForSource` method previously called `listSnapshotsForSource` through `this`, which made the method fragile if it was destructured or passed as a callback by orchestration code.

## Decision

Keep repository methods context-independent by closing over the shared `listSnapshotsForSource` implementation inside the factory and calling that closure from `findLatestSnapshotForSource`.

## Scope

- Does not change snapshot SQL queries.
- Does not change latest-snapshot ordering.
- Does not change Postgres integration behavior.

## Quality Bar

- `findLatestSnapshotForSource` works when extracted from the repository object.
- Existing list/latest snapshot behavior and row mapping stay unchanged.
- The repository remains a simple factory without adding a class wrapper.
