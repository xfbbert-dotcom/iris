# Iris Document Sync Claim Recheck Plan

## Goal

Prevent document sync workers from fetching document bodies when a source loses
permission or usage capability between the initial source read and the `syncing`
claim update.

## Steps

- [x] Add failing tests for permission and capability changes during the claim
  window.
- [x] Re-check the claimed source returned by `markSyncState(..., "syncing")`.
- [x] Restore denied or disabled claimed sources to `pending` and skip fetches.
- [x] Reuse one rejection helper for initial and post-claim checks.
- [x] Update the architecture whitepaper with the post-claim recheck rule.
- [x] Run full verification before commit and push.
