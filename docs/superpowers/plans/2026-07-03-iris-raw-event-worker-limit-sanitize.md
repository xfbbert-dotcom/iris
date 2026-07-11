# Iris Raw Event Worker Limit Sanitization Plan

**Goal:** Defensively sanitize non-finite direct raw event worker batch limits and reject unsafe finite batch limits.

- [x] **Step 1: Add failing worker coverage**
  - Prove `Infinity` and `NaN` are converted to `dequeueBatch(0)`.

- [x] **Step 2: Add sanitize helper**
  - Mirror the document sync worker finite check.
  - Use the helper before dequeuing raw events.

- [x] **Step 3: Verify focused and full suites**
  - Run focused raw event worker tests.
  - Run typecheck, Python tests, Docker Compose config, and full npm tests.

- [x] **Step 4: Commit and update PR**
  - Commit the patch with a scoped message.
  - Push the branch and append the PR description.

- [x] **Step 5: Reject unsafe finite direct-call limits**
  - Add a failing `RawEventWorker` test for `Number.MAX_SAFE_INTEGER + 1`.
  - Reject unsafe finite limits before `dequeueBatch()` while preserving `Infinity` and `NaN` to `0`.
