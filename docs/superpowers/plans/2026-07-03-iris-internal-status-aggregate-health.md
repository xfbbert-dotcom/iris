# Iris Internal Status Aggregate Health Plan

## Goal

Make the consolidated internal status easier to scan by deriving the top-level `ok` from component health while preserving HTTP 200 for readable degraded snapshots.

## Plan

- [x] Add a failing API assertion that a degraded component makes response body `ok` false.
- [x] Compute aggregate `ok` from the component status objects.
- [x] Run targeted core API tests.
- [x] Run full verification: typecheck, Python worker tests, Docker Compose config, and full npm test.
- [x] Commit and push the branch.
