# Iris Document Source Evidence Time Design

**Goal:** Keep document-source evidence timestamps valid before they enter the fact layer.

**Problem:** Registration paths copied `observedAt` with `new Date(input.observedAt)` but did not reject invalid dates. In-memory mode could store an invalid evidence timestamp, while Postgres mode would defer the failure until a database write.

**Decision:** Centralize document-source date normalization and reject invalid evidence timestamps before storing sources or opening a Postgres transaction.

**Quality Bar:** Invalid `observedAt` throws `DocumentSourceValidationError`, leaves in-memory state unchanged, and performs no Postgres transaction/query work.
