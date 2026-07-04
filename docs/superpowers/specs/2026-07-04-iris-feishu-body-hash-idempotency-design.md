# Iris Feishu Body Hash Idempotency Design

## Context

Feishu Gateway falls back to hashing the callback body when no usable platform
event ID is available. The current fallback hash is a small hand-rolled 32-bit
hash. It is deterministic, but its collision space is unnecessarily small for a
deduplication key.

## Decision

Fallback body idempotency keys must use SHA-256 over the serialized callback
body:

- platform event IDs remain preferred when valid and bounded;
- missing, blank, or oversized IDs use `body-<sha256 hex>`;
- duplicate fallback bodies still deduplicate deterministically;
- only fallback idempotency keys change.

## Testing

Add a Feishu Gateway test that asserts fallback body keys use a 64-character
hex SHA-256 digest, then run focused Gateway tests and full verification.
