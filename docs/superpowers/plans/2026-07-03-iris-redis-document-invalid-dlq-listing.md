# Iris Redis Document Invalid DLQ Listing Plan

**Goal:** Make Redis document DLQ listing and cleanup safe for malformed queue payload diagnostics.

- [x] **Step 1: Add failing DLQ listing coverage**
  - Document sync invalid raw payload DLQ entries list as non-replayable diagnostics.
  - Document reindex invalid raw payload DLQ entries list as non-replayable diagnostics.
  - Replay returns the existing unsupported status for invalid raw payload ids.
  - Delete removes invalid raw payload entries by stable id.

- [x] **Step 2: Extend Redis document DLQ parsing**
  - Store stable ids on invalid raw payload DLQ records.
  - Parse normal `job` and invalid `rawPayload` entries as a union.
  - Guard replay so invalid raw payload entries cannot be requeued.

- [x] **Step 3: Verify focused and full suites**
  - Run focused Redis document queue tests.
  - Run typecheck, Python tests, Docker Compose config, and full npm tests.

- [x] **Step 4: Commit and update PR**
  - Commit the patch with a scoped message.
  - Push the branch and append the PR description.
