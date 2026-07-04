# Iris Answer Context Limit Safe Number Plan

## Goal

Reject unsafe answer draft context limits at the API boundary before model
orchestration.

## Steps

- [x] Add failing API tests for unsafe `fragmentLimit` and `liveChatLimit`.
- [x] Reject non-finite or unsafe-magnitude context limits in the answer draft
  request parser.
- [x] Preserve existing finite safe fractional and negative limit behavior for
  downstream clamps.
- [x] Update the architecture whitepaper and focused design note.
- [x] Run focused and full verification before commit and push.
