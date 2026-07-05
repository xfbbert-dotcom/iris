# Iris Feishu Message ID Idempotency Design

**Goal:** Keep Feishu callback retries from duplicating message events when the callback lacks a usable platform event id.

**Problem:** The gateway fell back directly from `event_id` to a canonical body hash. Feishu retries can preserve `message_id` while adding retry metadata, which changes the body hash and lets the same message enter the raw queue twice.

**Decision:** Preserve the existing priority order for valid platform event IDs. If no valid event ID exists, derive a bounded `message:<message_id>` fallback from `event.message.message_id` or top-level `message.message_id`. Only use the canonical body hash when neither event ID nor message ID is usable.

**Quality Bar:** Two Feishu callbacks with the same `message_id`, no usable `event_id`, and different retry wrapper metadata produce the same idempotency key and deduplicate before queueing.
