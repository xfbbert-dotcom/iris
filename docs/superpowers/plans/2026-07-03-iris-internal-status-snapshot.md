# Iris Internal Status Snapshot Implementation Plan

- [x] Add failing API test for `GET /internal/status`.
- [x] Implement the consolidated internal status route.
- [x] Reuse existing runtime `getStatus()` methods and audit retention metadata.
- [x] Run targeted tests, typecheck, worker tests, compose validation, and the full test suite.
- [x] Commit and push the phase to PR #3.

## Notes

- This endpoint is for admin surfaces and smoke checks.
- It does not replace detailed per-component endpoints.
