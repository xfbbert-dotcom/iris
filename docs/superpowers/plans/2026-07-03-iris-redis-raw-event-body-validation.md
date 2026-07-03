# Iris Redis Raw Event Body Validation Plan

**Goal:** Reject malformed Redis raw event payloads before they reach the Feishu processor.

- [x] **Step 1: Add failing validation coverage**
  - Missing `rawBody` is rejected by `parseRawEvent`.
  - Non-object `rawBody` is rejected by `parseRawEvent`.
  - Dequeue dead-letters missing-body payloads and continues.

- [x] **Step 2: Require object raw bodies in Redis raw events**
  - Add an object-shape guard in `parseRawEvent`.
  - Preserve existing normalization and legacy attempts behavior.

- [x] **Step 3: Verify focused and full suites**
  - Run focused Redis raw event queue tests.
  - Run typecheck, Python tests, Docker Compose config, and full npm tests.

- [x] **Step 4: Commit and update PR**
  - Commit the patch with a scoped message.
  - Push the branch and append the PR description.
