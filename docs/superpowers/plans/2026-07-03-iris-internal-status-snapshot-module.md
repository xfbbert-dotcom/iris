# Iris Internal Status Snapshot Module Plan

## Goal

Move internal status snapshot derivation into a focused admin module with direct unit coverage.

## Plan

- [x] Add a failing unit test that imports the future snapshot builder module.
- [x] Move snapshot builder and component status helpers into `src/admin/internal-status-snapshot.ts`.
- [x] Update `app.ts` to import and call the builder.
- [x] Run targeted builder/API tests.
- [x] Run full verification: typecheck, Python worker tests, Docker Compose config, and full npm test.
- [x] Commit and push the branch.
