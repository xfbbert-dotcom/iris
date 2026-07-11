# Iris Feishu Fallback Idempotency Hash Design

**Goal:** Keep Feishu callback deduplication stable when an event lacks a usable platform event id.

**Problem:** The fallback idempotency key used a body hash over `JSON.stringify(payload)`. That is deterministic for one object instance, but semantically identical JSON objects with different key insertion order can hash differently and enter the queue twice.

**Decision:** Canonicalize fallback JSON before hashing: object keys are sorted recursively, arrays preserve order, and primitive JSON values remain unchanged. Platform event IDs still win whenever present and within budget.

**Quality Bar:** Two callbacks with the same body content but different object key order produce the same `body-<sha256>` idempotency key and deduplicate before queueing.
