# Iris In-Memory Reindex Queue Cloning Plan

**Goal:** Make `InMemoryDocumentReindexQueue` protect its internal state with defensive clones.

- [x] **Step 1: Add failing clone coverage**
  - Enqueued jobs are insulated from later caller mutation.
  - Listed DLQ entries are insulated from returned-object mutation.

- [x] **Step 2: Add clone helpers to in-memory reindex queue**
  - Clone jobs on enqueue, dequeue, retry, DLQ storage, DLQ listing, and replay.
  - Clone `Date` fields explicitly.

- [x] **Step 3: Verify focused and full suites**
  - Run focused in-memory reindex queue tests.
  - Run typecheck, Python tests, Docker Compose config, and full npm tests.

- [x] **Step 4: Commit and update PR**
  - Commit the patch with a scoped message.
  - Push the branch and append the PR description.
