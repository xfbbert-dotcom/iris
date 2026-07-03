# Iris Internal Status Generated Timestamp Plan

## Goal

Expose when the consolidated internal status snapshot was generated so operators and future admin UI can distinguish fresh status from stale displayed state.

## Plan

- [x] Add a failing API assertion for top-level `generatedAt` on `GET /internal/status`.
- [x] Add a `now` dependency to `buildApp` for deterministic status timestamp tests.
- [x] Return `generatedAt` as an ISO timestamp from the consolidated status endpoint.
- [x] Run targeted core API tests.
- [x] Run full verification: typecheck, Python worker tests, Docker Compose config, and full npm test.
- [x] Commit and push the branch.
