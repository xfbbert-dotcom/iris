# Iris Raw Event Id Bound Design

## Context

Feishu callback event IDs become raw-event idempotency keys and may be stored in
Redis sets. The current path trims blank IDs but does not cap length, so a
malformed external payload can create very large idempotency keys.

## Decision

Raw event ID material must be bounded:

- direct raw-event idempotency key creation rejects event IDs longer than 512
  characters;
- Feishu Gateway treats oversized external event IDs as unusable and falls back
  to the stable body hash, preserving ack-first behavior;
- normal event IDs remain unchanged.

## Testing

Add focused tests for direct helper rejection and Feishu Gateway hash fallback,
then run the raw-event queue and Feishu Gateway tests.
