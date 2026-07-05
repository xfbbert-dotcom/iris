# Iris Manual Sync Enqueue Rollback Design

## Pressure

Manual document sync is an operator recovery action. Before enqueueing a manual sync job, Iris may
reset a source from `synced` or `failed` to `pending` so the worker will fetch it again.

If Redis enqueue fails after that reset, the source can appear pending even though no queue job
exists. During the first 20-30 person rollout, that is worse than a clear failure: operators may
wait for a sync that cannot run.

## Contract

- Pending sources can enqueue without a state write.
- Non-pending eligible sources are reset to `pending` before enqueueing so the queued worker will
  process them.
- If enqueue fails after such a reset, Iris attempts to restore the previous sync state.
- The original queue error remains the surfaced error, even if best-effort restoration fails.
- Permission-denied, capability-disabled, missing, and already-syncing behavior is unchanged.

## Non-goals

- Adding a distributed transaction across Postgres and Redis.
- Removing existing manual sync idempotency keys.
- Changing document sync worker processing semantics.

## Verification

Focused planner tests must prove the queue-failure rollback path, plus the existing manual enqueue
paths for pending, synced, failed, denied, disabled, missing, and already-syncing sources.
