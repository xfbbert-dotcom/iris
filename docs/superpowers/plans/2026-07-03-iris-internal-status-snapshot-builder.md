# Iris Internal Status Snapshot Builder Plan

## Goal

Keep the consolidated internal status route maintainable by moving aggregate snapshot derivation into a focused helper.

## Plan

- [x] Extract internal status snapshot derivation into a helper.
- [x] Preserve the existing route response shape.
- [x] Run targeted core API tests.
- [x] Run full verification: typecheck, Python worker tests, Docker Compose config, and full npm test.
- [x] Commit and push the branch.
