# Iris Document Snapshot Error Read Budget Design

## Goal

Protect admin and sync-health responses from oversized legacy failed snapshot error messages already
stored in the database.

## Architecture

Reuse `normalizeDocumentSnapshotErrorMessage` at the document snapshot read boundary. Failed
snapshot inserts are already bounded; this patch also normalizes `error_message` inside
`mapSnapshotRow`.

This gives two layers of protection:

- New failed snapshots are bounded before persistence.
- Existing or externally inserted failed snapshot rows are bounded when read back.

## Invariants

- Successful snapshot rows remain unchanged.
- Failed snapshot status and timestamps are unchanged.
- Short failed snapshot messages remain unchanged except for trimming.
- Snapshot SQL queries and ordering are unchanged.

## Out Of Scope

- Migrating existing database rows in place.
- Redacting secret patterns inside snapshot errors.
- Changing snapshot body preview behavior.
- Changing document source sync-health response shape.
