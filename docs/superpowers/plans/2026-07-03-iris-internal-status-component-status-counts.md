# Iris Internal Component Status Counts Plan

## Goal

Expose precomputed component status counts for admin UI rendering and filtering.

## Plan

- [x] Add failing snapshot builder assertion for `summary.componentStatusCounts`.
- [x] Derive status counts from component-level status values.
- [x] Update `/internal/status` API expectations for the new summary field.
- [x] Run targeted builder/API tests.
- [x] Run full verification: typecheck, Python worker tests, Docker Compose config, and full npm test.
- [x] Commit and push the branch.
