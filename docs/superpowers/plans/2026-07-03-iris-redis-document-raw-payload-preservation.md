# Iris Redis Document Raw Payload Preservation Plan

**Goal:** Preserve exact invalid Redis queue payload strings in document DLQ diagnostics.

- [x] **Step 1: Add failing raw payload preservation coverage**
  - Document sync DLQ listing preserves a whitespace-only raw payload.
  - Document reindex DLQ listing preserves an empty raw payload.

- [x] **Step 2: Add dedicated raw payload parsing**
  - Stop using trimmed readers for invalid DLQ `rawPayload`.
  - Accept empty strings while still rejecting missing or non-string values.

- [x] **Step 3: Verify focused and full suites**
  - Run focused Redis document queue tests.
  - Run typecheck, Python tests, Docker Compose config, and full npm tests.

- [x] **Step 4: Commit and update PR**
  - Commit the patch with a scoped message.
  - Push the branch and append the PR description.
