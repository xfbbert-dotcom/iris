# Iris Internal Status Enabled Runtime Summary Plan

## Goal

Make the consolidated internal status show which enabled runtime components are running versus stopped.

## Plan

- [x] Add failing API assertions for enabled runtime running/stopped summary fields.
- [x] Derive enabled runtime summary fields from component `enabled` and `running` status.
- [x] Run targeted core API tests.
- [x] Run full verification: typecheck, Python worker tests, Docker Compose config, and full npm test.
- [x] Commit and push the branch.
