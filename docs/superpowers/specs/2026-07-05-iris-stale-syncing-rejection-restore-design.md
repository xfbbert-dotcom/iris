# Iris Stale Syncing Rejection Restore Design

## Pressure

Document sync sources can be left in `syncing` after a worker crash, persistence failure, or manual
repair. If the source later becomes permission-denied or fully disabled before another worker reads
it, the runner used to reject it immediately and preserve the stale `syncing` state.

That is a small-state bug with high product impact: an administrator can later re-enable the source,
but the planner may continue skipping it because it still looks in-flight.

## Contract

- Permission-denied and capability-disabled remain hard rejection reasons.
- A rejected source that is already `syncing` must be restored to `pending` before returning the
  rejection.
- Ordinary rejected sources that are not `syncing` must not perform an unnecessary state write.
- Restoring to `pending` is allowed to throw; the queue retry path should retry instead of silently
  preserving a stuck lock.
- The runner must not fetch the document body or write snapshots on these rejection paths.

## Non-goals

- Adding a lease timeout or distributed lock for `syncing`.
- Changing manual sync enqueue behavior.
- Changing `already_syncing` skip behavior for otherwise eligible sources.

## Verification

Focused document sync runner tests must cover stale `syncing` sources that become
permission-denied or fully disabled. Existing tests must continue to prove ordinary denied sources
do not write state and eligible `syncing` sources are skipped without fetching.
