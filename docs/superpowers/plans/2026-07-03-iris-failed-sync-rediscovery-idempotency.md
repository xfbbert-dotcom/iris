# Iris Failed Sync Rediscovery Idempotency Plan

**Goal:** Prevent duplicate evidence retries from reopening failed document sources.

- [x] **Step 1: Add failing registry coverage**
  - In-memory duplicate evidence retry keeps `syncState: failed`.
  - Postgres update SQL checks existing evidence before resetting failed state.

- [x] **Step 2: Update registry merge logic**
  - In-memory registry resets failed state only when evidence is new.
  - Postgres registry gates failed-to-pending reset with a matching evidence `not exists` check.

- [x] **Step 3: Verify focused and full suites**
  - Run focused registry tests.
  - Run typecheck, Python tests, Docker Compose config, and full npm tests.

- [x] **Step 4: Commit and update PR**
  - Commit the patch with a scoped message.
  - Push the branch and append the PR description.
