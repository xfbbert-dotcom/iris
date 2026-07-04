# Iris Answer Context Limit Safe Number Plan

## Goal

Reject unsafe answer draft context limits at the API boundary and in lower-level
context builders before model orchestration.

## Steps

- [x] Add failing API tests for unsafe `fragmentLimit` and `liveChatLimit`.
- [x] Reject non-finite or unsafe-magnitude context limits in the answer draft
  request parser.
- [x] Add failing lower-layer tests for unsafe `fragmentLimit` and
  `liveChatLimit` values.
- [x] Add failing orchestrator tests proving unsafe limits are rejected before
  stored live-chat reads or context building.
- [x] Reject unsafe-magnitude values inside retrieval context building and
  prompt assembly direct-call paths.
- [x] Reject unsafe-magnitude values inside the answer draft orchestrator before
  any live-chat history read.
- [x] Preserve existing finite safe fractional and negative limit behavior for
  downstream clamps.
- [x] Update the architecture whitepaper and focused design note.
- [x] Run focused and full verification before commit and push.
