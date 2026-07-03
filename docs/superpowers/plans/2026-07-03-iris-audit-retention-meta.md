# Iris Audit Retention Metadata Implementation Plan

- [x] Add failing unit test for in-memory retention capacity and dropped event count.
- [x] Add failing API expectations for retention metadata in audit query `meta`.
- [x] Track dropped audit events when the in-memory log trims overflow.
- [x] Expose retention metadata through both audit read endpoints.
- [x] Run targeted tests, typecheck, worker tests, compose validation, and the full test suite.
- [x] Commit and push the phase to PR #3.

## Notes

- `droppedEventCount` is process-local in the v1 in-memory implementation.
- This metadata makes the temporary in-memory limitation visible to operators.
