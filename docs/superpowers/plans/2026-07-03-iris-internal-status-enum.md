# Iris Internal Status Enum Plan

## Goal

Expose a stable top-level status enum for admin UI and internal tooling.

## Plan

- [x] Add failing API assertions for healthy and degraded status strings.
- [x] Derive `status` from aggregate `ok` inside the status snapshot builder.
- [x] Run targeted core API tests.
- [x] Run full verification: typecheck, Python worker tests, Docker Compose config, and full npm test.
- [x] Commit and push the branch.
