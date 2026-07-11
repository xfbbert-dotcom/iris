# Iris Raw Event Requeue Idempotency Plan

- [x] Add a failing in-memory raw event queue test for platform retry dedupe after failed-event requeue.
- [x] Update the Redis raw event queue retry test to require atomic `SADD + RPUSH` requeue.
- [x] Confirm both tests fail on the existing implementation.
- [x] Re-add in-memory seen keys when failed events are requeued.
- [x] Reuse the Redis atomic enqueue script for failed-event requeue.
- [x] Run focused raw event queue tests.
- [x] Run full verification before publishing.
- [x] Commit and push the change to the PR branch.
