# Iris Redis Document Queue Invalid Payload DLQ Plan

**Goal:** Prevent malformed Redis document queue payloads from aborting whole sync or reindex batches.

- [x] **Step 1: Add failing Redis queue coverage**
  - Document sync dequeue records an invalid raw payload to DLQ and continues to a later valid job.
  - Document reindex dequeue records an invalid raw payload to DLQ and continues to a later valid job.

- [x] **Step 2: Harden Redis document dequeue paths**
  - Wrap job parsing inside `dequeueBatch`.
  - Push invalid raw payload diagnostics to the existing queue-specific DLQ.
  - Preserve normal valid job return behavior.

- [x] **Step 3: Verify focused and full suites**
  - Run focused Redis document queue tests.
  - Run typecheck, Python tests, Docker Compose config, and full npm tests.

- [x] **Step 4: Commit and update PR**
  - Commit the patch with a scoped message.
  - Push the branch and append the PR description.
