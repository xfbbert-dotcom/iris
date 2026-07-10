# Iris Document Sync Worker Stale State Recovery Design

## Problem

The document-sync queue durably moves dequeued jobs into a Redis processing list and recovers them
after a worker restart. The document source's Postgres `syncState` is independent of that queue
ownership.

If the process stops after setting a source to `syncing`, the recovered job calls the runner again.
The runner currently returns `already_syncing`, and the worker acknowledges the job as processed.
The source remains stuck forever and the document is never fetched.

A similar gap exists for `synced`: the process can stop after writing the successful snapshot and
marking the source synced but before enqueueing reindex work or acknowledging the sync job. The
recovered job returns `already_synced` and is acknowledged, which can leave the snapshot unindexed.
Best-effort rollback failures after downstream errors create the same stale states.

## Decision

Distinguish ordinary direct runner calls from queue-owned crash recovery.

- `DocumentSyncRunner.syncSourceById` accepts an optional
  `recoverStaleSyncState` flag that defaults to false.
- Without the flag, eligible `syncing` and `synced` sources keep the existing
  `already_syncing` / `already_synced` skip behavior.
- The document-sync worker always passes `recoverStaleSyncState: true` because the v1 deployment
  contract allows only one active document-sync consumer and Redis has handed that worker the
  queued job.
- With recovery enabled, eligible `syncing` or `synced` sources are claimed again, policy is checked
  again after the claim, and the normal fetch, snapshot, state, and reindex-enqueue pipeline runs.
- Permission-denied or fully disabled sources keep the existing rejection and stale-lock cleanup
  behavior. Recovery never bypasses source policy.
- Recovered work may refetch and create a newer successful snapshot. This is an acceptable
  at-least-once recovery cost for the 20-30 person rollout and favors correctness over adding a
  cross-store outbox.

## Why Worker-Scoped Recovery Is Safe in v1

The manual planner does not enqueue eligible sources that are already `syncing`; normal manual
resync resets `synced` sources to `pending` before enqueue. The Redis queue also deduplicates one
logical source job while it is pending or processing. Under the documented single-consumer
constraint, a queued worker seeing `syncing` or `synced` therefore represents recovered or retried
ownership, not a competing live fetch.

## Alternatives Rejected

### Make every runner call reclaim stale states

This would remove the direct-call concurrency guard and allow accidental callers to start duplicate
fetches without proving queue ownership.

### Reset every syncing source at startup

A broad database sweep cannot prove which source belongs to this queue instance and would become
unsafe as soon as another process is active.

### Add leases or a transactional outbox now

Leases and an outbox are the stronger multi-replica design, but they add schema, renewal, timeout,
and cross-store coordination that the single-company v1 deployment does not need.

## Evolution

Before document-sync workers scale horizontally, replace the boolean recovery authority with
per-consumer queue ownership and a source-state lease or transactional outbox. A worker must then
prove ownership before reclaiming `syncing` or `synced` state.

## Quality Bar

- Direct runner calls still skip ordinary eligible `syncing` and `synced` sources.
- Queue worker calls explicitly enable stale-state recovery.
- Recovery refetches and completes both stale states through the normal pipeline.
- Denied and disabled sources remain rejected and are never fetched.
- Focused tests, full verification, independent review, and GitHub CI pass.
