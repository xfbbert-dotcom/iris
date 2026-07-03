# Iris Internal Status Component Order Plan

## Goal

Expose a stable component display order for admin UI clients.

## Plan

- [x] Add a failing API assertion for top-level `componentOrder`.
- [x] Derive `componentOrder` from the returned component map.
- [x] Run targeted core API tests.
- [x] Run full verification: typecheck, Python worker tests, Docker Compose config, and full npm test.
- [x] Commit and push the branch.
