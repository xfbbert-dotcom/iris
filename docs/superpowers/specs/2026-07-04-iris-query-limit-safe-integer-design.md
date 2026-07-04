# Iris Query Limit Safe Integer Design

## Context

Internal admin APIs use query `limit` values for audit events, source inventory,
snapshot lists, and dead-letter lists. The parser capped large limits to 100, but
did not reject values outside JavaScript's safe integer range. That could turn
malformed operator input into an apparently valid request.

## Decision

Shared query-limit parsing must reject non-integer, negative, and unsafe integer
values before applying the existing maximum cap. Safe large integers can still
be capped to 100, but unsafe integers are invalid requests.

## Consequences

- Admin APIs fail loudly for numerically unsafe limits instead of silently
  normalizing them.
- Dead-letter and source inventory endpoints share the same guard through the
  common parser.
- Existing default and maximum cap behavior remains unchanged for safe values.
