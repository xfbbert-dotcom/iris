# Iris Mention Fact Persistence Isolation Plan

- [x] Add a failing processor test where message fact persistence throws before an explicit mention reply.
- [x] Verify the red failure: the mention responder was not called.
- [x] Move explicit mention response attempts before message fact persistence.
- [x] Keep message fact persistence failures retryable and skip document discovery when the fact write fails.
- [x] Verify the focused persistence-failure mention test passes.
- [x] Verify the full Feishu message event processor test file passes.
- [x] Run full repository verification.
- [x] Commit and push the hardening change to the PR branch.
