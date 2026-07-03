# Iris Audit Summary Filters Implementation Plan

- [x] Add a failing unit test for `InMemoryAuditLog.summarizeRecent` filtered by `documentId` and `type`.
- [x] Add failing API tests for audit summary filters and invalid filter rejection.
- [x] Implement optional `documentId` and `type` filters in `summarizeRecent`.
- [x] Parse and validate summary query filters in the internal API route.
- [x] Run targeted tests, typecheck, worker tests, compose validation, and the full test suite.
- [x] Commit and push the phase to PR #3.

## Notes

- `limit` is applied before filters, matching the recent-event-window model.
- Filter support is intentionally narrow: document and event type only.
