# Iris Manual Sync Stale Lock Restore Implementation Plan

## Goal

Let manual sync requests clear stale `syncing` locks when the source is now denied or fully
disabled, without enqueueing unsafe sync work.

## Steps

- [x] Add failing manual planner tests for stale `syncing` denied and disabled sources.
- [x] Observe the focused tests fail because no `pending` restore happens.
- [x] Restore stale `syncing` rejected sources to `pending` before returning the rejection.
- [x] Confirm the focused manual planner tests pass.
- [x] Run the full manual planner test file.
- [x] Run related document sync tests and full repository verification.
- [ ] Commit, push, update PR #3, and verify GitHub checks.
