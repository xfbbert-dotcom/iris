# Iris Audit Event Summary Implementation Plan

- [x] Add a failing unit test for in-memory audit summaries grouped by document and event type.
- [x] Add a failing API test for `GET /internal/audit/events/summary`.
- [x] Implement `InMemoryAuditLog.summarizeRecent`.
- [x] Expose the internal summary endpoint with ISO timestamp responses.
- [x] Run targeted tests, typecheck, worker tests, compose validation, and the full test suite.
- [x] Commit and push the phase to PR #3.

## Notes

- This is intentionally in-memory for the current rollout.
- The endpoint summarizes the newest `limit` raw audit events, not the newest `limit` summary rows.
- Durable audit history remains a later Postgres-backed phase.
