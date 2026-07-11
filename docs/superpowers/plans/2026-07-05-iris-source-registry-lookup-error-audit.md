# Iris Source Registry Lookup Error Audit Plan

- [x] Add a failing runtime test where `source-policy` source lookup throws `registry unavailable`.
- [x] Verify the red failure: the audit log recorded `permission_guard_denied` instead of `permission_guard_error`.
- [x] Let source-registry lookup exceptions propagate from the answer draft runtime permission callback.
- [x] Verify the focused `local source policy` runtime test passes.
- [x] Verify the full answer draft runtime test suite passes.
- [x] Run full repository verification.
- [x] Commit and push the hardening change to the PR branch.
