# Iris Audit Zero-Limit Regression Implementation Plan

- [x] Add API regression test for `GET /internal/audit/events?limit=0`.
- [x] Add API regression test for `GET /internal/audit/events/summary?limit=0`.
- [x] Confirm the current shared diagnostics implementation already satisfies the behavior.
- [x] Run targeted tests, typecheck, worker tests, compose validation, and the full test suite.
- [x] Commit and push the phase to PR #3.

## Notes

- This is a test-only behavior lock.
- The target tests passed immediately because the previous audit query metadata implementation already included the `limit <= 0` guard.
