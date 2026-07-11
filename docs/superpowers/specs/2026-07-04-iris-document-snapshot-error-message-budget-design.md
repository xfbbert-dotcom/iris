# Iris Document Snapshot Error Message Budget Design

## Goal

Prevent oversized document fetch failure diagnostics from bloating failed snapshots and internal
status responses.

## Architecture

Add `normalizeDocumentSnapshotErrorMessage` as the document snapshot failure boundary. The helper:

- Trims short error messages.
- Falls back to `unknown error` for blank messages.
- Truncates oversized messages to `1000` characters with ` ... [truncated]`.

The helper is applied in two places:

- `document-sync-pipeline` normalizes fetch failures before returning failed sync results or
  passing them to the snapshot writer.
- `document-snapshot-repository` normalizes failed snapshot inserts before persisting them.

This keeps both runtime results and the persistence boundary bounded, even if future code paths
write failed snapshots without going through the current sync runner.

## Invariants

- Successful snapshot body storage is unchanged.
- Short failure messages remain human-readable and unchanged except for trimming.
- Failed source state transitions are unchanged.
- The original fetch failure still causes a failed snapshot and `syncState = failed`.

## Out Of Scope

- Redacting secret patterns inside document fetch errors.
- Bounding successful document body text.
- Changing document sync retry or dead-letter behavior.
- Changing how failed snapshots are displayed in the admin API.
