# Iris Internal Status Degraded Component List Plan

## Goal

Make the consolidated internal status directly actionable by listing which components are degraded in the summary.

## Plan

- [x] Add failing API assertions for `summary.degradedComponents` in healthy and degraded snapshots.
- [x] Derive degraded component keys from the consolidated component status map.
- [x] Run targeted core API tests.
- [x] Run full verification: typecheck, Python worker tests, Docker Compose config, and full npm test.
- [x] Commit and push the branch.
