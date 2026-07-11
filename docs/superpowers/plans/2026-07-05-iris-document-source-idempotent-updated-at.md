# Iris Document Source Idempotent UpdatedAt Plan

- [x] Add an in-memory registry test for duplicate evidence retries preserving `updatedAt`.
- [x] Add a Postgres registry SQL test that rejects unconditional `updated_at` refreshes.
- [x] Verify the red failures for both in-memory and Postgres registry paths.
- [x] Update in-memory source merging to refresh `updatedAt` only on effective source changes.
- [x] Update Postgres registration SQL to conditionally refresh `updated_at`.
- [x] Verify the focused registry tests pass.
- [x] Run full repository verification.
- [x] Commit and push the hardening change to the PR branch.
