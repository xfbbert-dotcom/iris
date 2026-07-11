# Iris Snapshot Repository Context Plan

- [x] Add a failing unit test for extracted `findLatestSnapshotForSource`.
- [x] Confirm the test fails because `this.listSnapshotsForSource` loses method context.
- [x] Move `listSnapshotsForSource` into a closed-over helper.
- [x] Call the helper from `findLatestSnapshotForSource`.
- [x] Run focused document snapshot repository tests.
- [x] Run full verification before publishing.
- [x] Commit and push the change to the PR branch.
