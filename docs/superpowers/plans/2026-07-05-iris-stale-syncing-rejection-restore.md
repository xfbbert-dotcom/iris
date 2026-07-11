# Iris Stale Syncing Rejection Restore Implementation Plan

## Goal

Prevent rejected document sources from staying stuck in `syncing` when they have already become
permission-denied or fully disabled.

## Steps

- [x] Add failing document sync runner tests for stale `syncing` sources rejected by permission
  denial and disabled capabilities.
- [x] Observe the focused tests fail because the runner returns the stale `syncing` source.
- [x] Restore stale `syncing` rejected sources to `pending` before returning the rejection.
- [x] Confirm the focused tests pass.
- [x] Run the full document sync pipeline test file.
- [x] Run related document sync tests and full repository verification.
- [ ] Commit, push, update PR #3, and verify GitHub checks.
