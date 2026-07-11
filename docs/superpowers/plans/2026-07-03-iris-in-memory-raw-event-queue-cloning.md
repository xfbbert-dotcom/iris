# Iris In-Memory Raw Event Queue Cloning Plan

**Goal:** Prevent caller mutations from corrupting `InMemoryRawEventQueue` state.

- [x] **Step 1: Add failing clone coverage**
  - Enqueued raw events are insulated from later caller mutation.
  - Requeued failed raw events are insulated from later caller mutation.

- [x] **Step 2: Add raw event clone helpers**
  - Clone `receivedAt` as a new `Date`.
  - Deep clone `rawBody` with `structuredClone`.
  - Use clones on enqueue, dequeue, retry, and DLQ storage.

- [x] **Step 3: Verify focused and full suites**
  - Run focused raw event queue tests.
  - Run typecheck, Python tests, Docker Compose config, and full npm tests.

- [x] **Step 4: Commit and update PR**
  - Commit the patch with a scoped message.
  - Push the branch and append the PR description.
