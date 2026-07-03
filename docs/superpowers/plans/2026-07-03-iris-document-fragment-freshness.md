# Iris Document Fragment Freshness Plan

- [x] Add a failing repository test proving vector search must join the latest successful snapshot per document source.
- [x] Update vector search SQL to filter through latest successful snapshots.
- [x] Add deterministic tie-breakers after vector distance ranking.
- [x] Run focused fragment repository tests.
- [x] Add a failing migration test for profile-scoped fragment uniqueness.
- [x] Add a migration that replaces old snapshot/chunk uniqueness with snapshot/profile/chunk uniqueness.
- [x] Run focused migration tests.
- [x] Run full verification before publishing.
- [x] Commit and push the change to the PR branch.
