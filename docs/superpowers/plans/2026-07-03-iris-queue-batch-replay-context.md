# Iris Queue Batch Replay Context Plan

- [x] Add failing tests for extracted batch dead-letter replay on document sync and reindex queues.
- [x] Confirm the tests fail because `this.replayDeadLetter` loses method context.
- [x] Make factory-created queue batch replay methods call closed-over replay functions.
- [x] Bind the in-memory reindex replay/delete methods on construction.
- [x] Run focused queue replay tests.
- [x] Run full verification before publishing.
- [x] Commit and push the change to the PR branch.
