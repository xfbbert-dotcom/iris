# Iris Denied Source Capability Lock Plan

## Goal

Keep all document-content capabilities disabled while a document source is
marked denied, including during later policy updates and source registration
upgrades.

## Steps

- [x] Add failing in-memory registry tests for denied knowledge draft usage.
- [x] Add failing Postgres registry SQL tests for denied knowledge draft usage.
- [x] Disable knowledge drafts when marking permission denied.
- [x] Preserve denied knowledge draft lock during policy updates.
- [x] Preserve denied knowledge draft lock during registration/source-type upgrades.
- [x] Update the architecture whitepaper and focused design note.
- [x] Run full verification before commit and push.
