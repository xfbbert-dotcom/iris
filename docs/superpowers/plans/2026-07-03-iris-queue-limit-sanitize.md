# Iris Queue Limit Sanitization Plan

**Goal:** Make queue-level batch and DLQ list limits defensive against non-finite and unsafe-magnitude values.

- [x] **Step 1: Add failing queue coverage**
  - In-memory raw event dequeue treats `Infinity` as zero and preserves the event.
  - In-memory reindex dequeue and DLQ listing treat `Infinity` as zero.
  - Redis raw event, document sync, and document reindex dequeue treat `Infinity`/`NaN` as zero.
  - Redis document sync and reindex DLQ listing treats `Infinity`/`NaN` as zero.

- [x] **Step 2: Add queue-level sanitize helpers**
  - Replace direct `Math.max(0, Math.floor(...))` with finite-aware helpers in affected queues.
  - Preserve existing finite limit behavior.

- [x] **Step 3: Verify focused and full suites**
  - Run focused queue tests.
  - Run typecheck, Python tests, Docker Compose config, and full npm tests.

- [x] **Step 4: Commit and update PR**
  - Commit the patch with a scoped message.
  - Push the branch and append the PR description.

- [x] **Step 5: Reject unsafe finite queue limits**
  - Add failing tests for unsafe finite dequeue limits in in-memory and Redis raw event, document sync, and document reindex queues.
  - Add failing tests for unsafe finite DLQ list limits in in-memory and Redis document sync/reindex queues.
  - Reject unsafe finite limits before queue consumption or Redis `lPop`/`lRange`, while preserving non-finite-to-zero behavior.
