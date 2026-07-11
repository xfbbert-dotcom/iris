# Iris Internal Status Summary Plan

## Goal

Make the consolidated internal status easier to scan by exposing component health counts alongside detailed component payloads.

## Plan

- [x] Add failing API assertions for healthy and degraded status summaries.
- [x] Derive summary counts from the component status objects.
- [x] Run targeted core API tests.
- [x] Run full verification: typecheck, Python worker tests, Docker Compose config, and full npm test.
- [x] Commit and push the branch.
