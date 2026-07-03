# Iris Audit Query Metadata Implementation Plan

- [x] Add failing API assertions for audit event response metadata.
- [x] Add failing API assertions for audit summary response metadata.
- [x] Implement shared query diagnostics for retained, inspected, and matching event counts.
- [x] Reuse the diagnostic helper from both audit read endpoints.
- [x] Run targeted tests, typecheck, worker tests, compose validation, and the full test suite.
- [x] Commit and push the phase to PR #3.

## Notes

- This is additive response metadata only.
- `limit=0` explicitly inspects zero events.
- `matchingEventCount` counts raw events matching filters, not summary rows.
