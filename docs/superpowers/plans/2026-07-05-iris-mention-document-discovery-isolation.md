# Iris Mention Document Discovery Isolation Plan

- [x] Add a failing message-processor test where a message contains both an @Iris mention and a document link, and document discovery throws.
- [x] Verify the red failure: the mention responder was not called when sync planning failed.
- [x] Reorder processor side effects so mention response is attempted before document discovery.
- [x] Preserve retry visibility by rethrowing mention or document discovery errors after both attempts that are allowed by runtime gates.
- [x] Verify focused Feishu message processor tests pass.
- [x] Run focused event-worker and mention reply tests.
- [x] Run full repository verification.
- [x] Commit and push the mention/document isolation hardening to the PR branch.
