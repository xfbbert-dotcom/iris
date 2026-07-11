# Iris In-Memory Reindex Queue Cloning Design

## Problem

`InMemoryDocumentReindexQueue` stores and returns `DocumentReindexJob` objects by
reference. A caller can mutate a job after enqueueing or mutate a listed DLQ entry,
which changes queue state outside the queue API. The document sync in-memory queue
already uses defensive cloning; reindex should match that behavior.

This matters during the small-team Phase 2B in-memory rollout because tests and
local workers may reuse objects across calls.

## Decision

Clone reindex jobs at every state boundary:

- when enqueueing
- when dequeueing
- when requeueing failed jobs
- when storing and listing DLQ entries
- when replaying DLQ entries

Dates should be cloned as `Date` instances, not shared references.

## Non-Goals

- Do not change dedupe, retry, or DLQ semantics.
- Do not change Redis queue behavior.

## Quality Bar

- Mutating an input job after enqueue does not mutate queued state.
- Mutating a listed DLQ item does not mutate stored DLQ state.
- Existing in-memory reindex behavior remains unchanged.
