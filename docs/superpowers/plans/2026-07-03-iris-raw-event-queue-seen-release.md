# Iris Raw Event Queue Seen Release Plan

- [x] Add a failing Redis raw event queue test for releasing dequeued idempotency keys.
- [x] Add a failing in-memory raw event queue test for retry enqueue after dequeue.
- [x] Release Redis raw event seen keys after valid dequeue.
- [x] Release in-memory raw event seen keys after dequeue.
- [x] Expose `sRem` through the event worker runtime Redis client adapter.
- [x] Run focused raw queue tests.
- [x] Run full verification before publishing.
- [x] Commit and push the change to the PR branch.
