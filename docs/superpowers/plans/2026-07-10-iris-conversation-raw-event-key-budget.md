# Iris Conversation Raw Event Key Budget Plan

- [x] Add a failing repository regression for the maximum valid raw event
  idempotency key.
- [x] Confirm the red failure is the conversation repository's generic
  512-character limit.
- [x] Make conversation message storage validate `rawEventIdempotencyKey`
  against the raw event queue's idempotency-key budget.
- [x] Keep independent conversation identifiers on the existing 512-character
  budget.
- [x] Run the focused conversation repository tests.
