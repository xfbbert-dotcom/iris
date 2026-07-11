# Iris Legacy Feishu Event Queue Cloning Plan

**Goal:** Prevent caller mutations from corrupting legacy in-memory Feishu event queue state.

- [x] **Step 1: Add failing clone coverage**
  - Enqueued legacy events are insulated from later caller mutation.
  - Returned `queue.events` entries are insulated from returned-object mutation.

- [x] **Step 2: Add clone helper and events getter**
  - Store events in a private backing array.
  - Return cloned events from the public getter.
  - Clone `receivedAt` and deep clone `body`.

- [x] **Step 3: Verify focused and full suites**
  - Run focused Feishu gateway tests.
  - Run typecheck, Python tests, Docker Compose config, and full npm tests.

- [x] **Step 4: Commit and update PR**
  - Commit the patch with a scoped message.
  - Push the branch and append the PR description.
