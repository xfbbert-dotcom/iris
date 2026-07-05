# Iris Worker Error Normalization Plan

- [x] Add a worker error normalizer test for standard `Error` messages.
- [x] Add a failing worker error normalizer test for a non-stringifiable thrown value.
- [x] Verify the red failure: the normalizer throws while reading the thrown value.
- [x] Make worker error-message reading best-effort and non-throwing.
- [x] Verify the focused worker-error normalizer test passes.
- [x] Run full repository verification.
- [x] Commit and push the hardening change to the PR branch.
