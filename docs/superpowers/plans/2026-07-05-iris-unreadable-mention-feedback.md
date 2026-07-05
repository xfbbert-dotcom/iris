# Iris Unreadable Mention Feedback Plan

- [x] Add a failing responder test where Iris is mentioned with `text: undefined`.
- [x] Verify the red failure: the responder sent the blank-question clarification.
- [x] Add a dedicated unreadable-message clarification path before question stripping.
- [x] Keep deterministic reply UUID, thread reply behavior, and handled-message dedupe.
- [x] Verify the focused unreadable-message responder test passes.
- [x] Verify the full mention responder test file passes.
- [x] Run full repository verification.
- [x] Commit and push the hardening change to the PR branch.
