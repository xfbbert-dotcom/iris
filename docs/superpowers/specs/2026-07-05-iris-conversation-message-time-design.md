# Iris Conversation Message Time Design

**Goal:** Keep stored live-chat context ordered by valid event timestamps.

**Problem:** Conversation message upserts accepted `sentAt` without validating it. A malformed Feishu event or future adapter bug could send `Invalid Date` into Postgres and compromise recent-message ordering.

**Decision:** Validate `sentAt` in the Postgres conversation message repository before issuing the upsert query.

**Quality Bar:** Invalid `sentAt` rejects with `sentAt must be a valid date` and does not call the query layer.
