# Iris Document Snapshot Time Design

**Goal:** Keep document snapshot timestamps valid before snapshot persistence.

**Problem:** Snapshot inserts accepted `fetchedAt` values without checking that they represented a valid date. A bad fetcher result could advance into the database write path and fail late or corrupt snapshot ordering.

**Decision:** Normalize snapshot dates before insert construction. Invalid `fetchedAt` values must throw before any query is issued for both succeeded and failed snapshots.

**Quality Bar:** Focused tests prove invalid succeeded and failed snapshot timestamps throw `fetchedAt must be a valid date` and leave the query layer untouched.
