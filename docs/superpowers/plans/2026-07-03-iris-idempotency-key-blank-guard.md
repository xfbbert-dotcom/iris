# Iris Idempotency Key Blank Guard Plan

**Goal:** Prevent blank IDs from producing colliding queue idempotency keys.

- [x] **Step 1: Add failing key factory tests**
  - Raw event idempotency rejects blank `eventId`.
  - Document sync idempotency rejects blank `documentSourceId`.
  - Reindex idempotency rejects blank `embeddingProfileId` and `documentSnapshotId`.

- [x] **Step 2: Add key factory guards**
  - Normalize IDs through a field-specific nonblank helper in each domain module.
  - Preserve existing trimming behavior for valid IDs.

- [x] **Step 3: Verify focused and full suites**
  - Run focused queue tests.
  - Run typecheck, Python tests, Docker Compose config, and full npm tests.

- [x] **Step 4: Commit and update PR**
  - Commit the patch with a scoped message.
  - Push the branch and append the PR description.
