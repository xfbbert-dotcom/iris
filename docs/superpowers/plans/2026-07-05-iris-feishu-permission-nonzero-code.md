# Iris Feishu Permission Non-Zero Code Plan

- [x] Add a permission checker test for known Feishu permission-denied code in an HTTP success response.
- [x] Add a failing permission checker test for an unknown non-zero Feishu code.
- [x] Verify the red failure: the unknown code resolved `false` instead of throwing.
- [x] Add explicit known-denied code handling and throw for other non-zero codes.
- [x] Verify the focused unknown-code test passes.
- [x] Verify the full Feishu document permission checker test file passes.
- [x] Run full repository verification.
- [x] Commit and push the hardening change to the PR branch.
