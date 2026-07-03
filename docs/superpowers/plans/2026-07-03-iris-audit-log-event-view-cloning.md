# Iris Audit Log Event View Cloning Plan

**Goal:** Protect in-memory audit history from mutations through the public `events` view.

- [x] **Step 1: Add failing audit event view coverage**
  - Mutating a returned audit event does not mutate stored history.
  - Mutating returned `fragmentIds` does not mutate stored history.

- [x] **Step 2: Add private storage and cloned getter**
  - Move storage to a private backing array.
  - Return cloned events from `events`.
  - Update retention and summaries to use private storage.

- [x] **Step 3: Verify focused and full suites**
  - Run focused audit log tests.
  - Run typecheck, Python tests, Docker Compose config, and full npm tests.

- [x] **Step 4: Commit and update PR**
  - Commit the patch with a scoped message.
  - Push the branch and append the PR description.
