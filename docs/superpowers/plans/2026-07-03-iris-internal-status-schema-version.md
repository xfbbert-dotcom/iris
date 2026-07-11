# Iris Internal Status Schema Version Plan

## Goal

Expose a stable schema version on the consolidated internal status response for future admin UI compatibility.

## Plan

- [x] Add a failing API assertion for top-level `schemaVersion`.
- [x] Return `schemaVersion: 1` from the internal status snapshot builder.
- [x] Run targeted core API tests.
- [x] Run full verification: typecheck, Python worker tests, Docker Compose config, and full npm test.
- [x] Commit and push the branch.
