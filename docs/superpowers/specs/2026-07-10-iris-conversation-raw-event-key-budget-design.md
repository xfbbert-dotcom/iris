# Iris Conversation Raw Event Key Budget Design

Status: Focused hardening patch for Iris v1 internal rollout

## Problem

The raw event queue accepts idempotency keys up to its own contract:
`raw-event:feishu:` plus a 512-character platform event identifier. Conversation
message persistence stores that same idempotency key as evidence, but it reused
the generic 512-character conversation identifier limit.

That creates a boundary mismatch: Iris can accept a valid Feishu callback into
the raw event queue, then fail repeatedly when writing the corresponding
conversation fact.

## Decision

Conversation message storage treats `rawEventIdempotencyKey` as upstream
evidence and validates it against `MAX_RAW_EVENT_IDEMPOTENCY_KEY_LENGTH`.

Other conversation identifiers keep the existing 512-character budget:

- provider message IDs;
- chat IDs;
- sender IDs;
- message types.

## Acceptance Criteria

- A conversation message can be upserted with the longest raw event idempotency
  key allowed by the raw event queue.
- A key one Feishu event-ID character above that budget is rejected before
  querying Postgres.
- Existing validation for other conversation identifiers remains unchanged.
