# Iris Permission Fragment Key Plan

- [x] Add a failing retrieval context test where two retrieved fragments share one `id` but belong to different document sources.
- [x] Verify the red failure: the denied document text entered prompt context when the permission map used only `fragment.id`.
- [x] Change answer-time permission mapping to use a compound key of fragment ID and document/source ID.
- [x] Verify the focused retrieval context test passes.
- [x] Run focused permission/retrieval tests.
- [x] Run full repository verification.
- [x] Commit and push the hardening change to the PR branch.
