# Iris Manual Sync Stale Lock Restore Design

## Pressure

Manual document sync is an operator recovery action. If a source is stuck in `syncing` and then
becomes permission-denied or fully disabled, a manual sync request used to reject it but keep the
stale in-flight lock.

For a 20-30 person rollout, that creates confusing operator UX: the request says "not allowed" but
does not actually clear the stuck sync state that may block a later administrator re-enable.

## Contract

- Manual sync must still reject permission-denied and fully disabled sources.
- If the rejected source is already `syncing`, manual sync restores it to `pending` before returning
  the rejection.
- Manual sync must not enqueue a document sync job on these rejected paths.
- Ordinary denied or disabled sources that are not `syncing` must not perform an unnecessary state
  write.
- Eligible sources that are already `syncing` still return `already_syncing` without restoration.

## Non-goals

- Adding force-sync semantics for denied or disabled sources.
- Changing queue idempotency keys.
- Adding sync-state leases.

## Verification

Focused manual planner tests must cover stale `syncing` denied and disabled sources, plus the
existing manual planner file must continue to cover pending, synced, failed, enqueue rollback,
missing, ordinary rejected, and eligible `already_syncing` behavior.
