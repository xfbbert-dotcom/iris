# Iris Internal Status Degraded Components Plan

## Goal

Keep `GET /internal/status` useful when one component status provider fails, so the backend homepage can still show the rest of Iris' operational state.

## Plan

- [x] Add a failing API test where one worker status provider throws and the consolidated status endpoint must still return 200.
- [x] Add component-level fallback handling for event worker, document sync, and reindex status providers.
- [x] Preserve successful status payloads for unaffected components.
- [x] Run targeted core API tests.
- [x] Run full verification: typecheck, Python worker tests, Docker Compose config, and full npm test.
- [x] Commit and push the branch.
