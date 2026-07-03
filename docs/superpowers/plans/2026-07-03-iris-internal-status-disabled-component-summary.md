# Iris Internal Status Disabled Component Summary Plan

## Goal

Make the consolidated internal status distinguish intentionally disabled components from degraded components.

## Plan

- [x] Add failing API assertions for enabled/disabled component counts and disabled component keys.
- [x] Derive disabled component summary fields from the component status map.
- [x] Run targeted core API tests.
- [x] Run full verification: typecheck, Python worker tests, Docker Compose config, and full npm test.
- [x] Commit and push the branch.
