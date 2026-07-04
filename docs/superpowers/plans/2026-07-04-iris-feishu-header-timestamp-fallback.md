# Iris Feishu Header Timestamp Fallback Plan

## Goal

Use Feishu `header.create_time` as the second timestamp fallback for message
facts before falling back to local receive time.

## Steps

- [x] Add a failing processor test for invalid message `create_time` with valid
  header `create_time`.
- [x] Parse `header.create_time` as the fallback passed into message timestamp
  parsing.
- [x] Preserve `RawEvent.receivedAt` fallback when both Feishu timestamps are
  invalid.
- [x] Run focused and full verification before commit and push.
