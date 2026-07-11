# Iris Audit Event Filters Implementation Plan

- [x] Add failing API tests for raw audit event `documentId` and `type` filters.
- [x] Add failing API test for invalid raw audit event filter rejection.
- [x] Parse raw audit event query filters with the same validation as summary filters.
- [x] Filter the newest retained event window and preserve newest-first response order.
- [x] Run targeted tests, typecheck, worker tests, compose validation, and the full test suite.
- [x] Commit and push the phase to PR #3.

## Notes

- `limit` is applied before filters, matching the summary endpoint and the in-memory recent-window model.
- This is a read-side operator tool; it does not change how audit events are recorded.
