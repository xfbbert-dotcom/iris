# Iris Internal Component Status Plan

## Goal

Make every internal status component directly renderable by adding a stable component-level status enum.

## Plan

- [x] Add failing API assertions for healthy, disabled, degraded, and stopped component statuses.
- [x] Derive component status values inside the internal status snapshot builder.
- [x] Run targeted core API tests.
- [x] Run full verification: typecheck, Python worker tests, Docker Compose config, and full npm test.
- [x] Commit and push the branch.
