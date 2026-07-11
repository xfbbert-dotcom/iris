# Iris Document Sync Claimed Source Fetch Plan

## Goal

Make document sync use the claimed source returned by `markSyncState(...,
"syncing")` for external fetches and snapshot writes.

## Steps

- [x] Add a failing runner test where the pre-claim source and claimed source
  have different `sourceUri` values.
- [x] Fetch document bodies with the claimed source.
- [x] Write succeeded and failed snapshots using the claimed source identity and
  URI.
- [x] Use the claimed source id for later sync-state transitions and pending
  restoration.
- [x] Run focused and full verification before commit and push.
