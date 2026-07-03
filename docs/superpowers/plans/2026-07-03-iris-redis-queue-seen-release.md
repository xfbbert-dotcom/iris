# Iris Redis Queue Seen Release Plan

- [x] Add failing Redis document sync coverage for releasing dequeued idempotency keys.
- [x] Add failing Redis document reindex coverage for releasing dequeued idempotency keys.
- [x] Add failing in-memory reindex coverage for re-enqueue after completion.
- [x] Release Redis seen keys after valid dequeue.
- [x] Reclaim Redis seen keys for failed-job retries and DLQ replay through atomic enqueue.
- [x] Align in-memory reindex queue key lifecycle with pending work.
- [x] Run focused queue tests and typecheck.
- [x] Run full verification before publishing.
- [x] Commit and push the change to the PR branch.
