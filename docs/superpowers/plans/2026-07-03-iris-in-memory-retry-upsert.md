# Iris In-Memory Retry Upsert Plan

- [x] Add a failing raw event queue test where a platform retry is pending before the in-flight event fails.
- [x] Add a failing document reindex queue test where a duplicate job is pending before the in-flight job fails.
- [x] Confirm both tests fail on duplicate or stale attempt-zero pending items.
- [x] Replace pending in-memory raw events when failed-event retry state is newer.
- [x] Replace pending in-memory reindex jobs when failed-job retry state is newer.
- [x] Run focused raw event and reindex queue tests.
- [x] Run full verification before publishing.
- [x] Commit and push the change to the PR branch.
