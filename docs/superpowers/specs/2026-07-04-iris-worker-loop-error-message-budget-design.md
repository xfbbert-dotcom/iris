# Iris Worker Loop Error Message Budget Design

## Goal

Prevent oversized batch-level worker failures from bloating internal status snapshots.

## Architecture

Add `normalizeWorkerErrorMessage` as the shared worker diagnostic boundary. The helper:

- Converts `Error` and non-`Error` failures to text.
- Trims short messages.
- Falls back to `unknown error` for blank messages.
- Truncates oversized messages to `1000` characters with ` ... [truncated]`.

Raw event, document sync, and document reindex worker loops use the helper only when writing
`latestBatch.errorMessage` for failed batch snapshots. The `onError` observer still receives the
original error object so logging and alerting integrations can preserve full diagnostic detail
outside the internal status response.

## Invariants

- Successful batch count snapshots are unchanged.
- Worker retry and dead-letter behavior is unchanged.
- `onError` hooks still receive the original thrown error.
- Failed loop snapshots remain explicit and human-readable, with truncation visible.

## Out Of Scope

- Redacting secret patterns inside worker errors.
- Bounding per-job failure messages returned from direct worker `processBatch` calls.
- Changing worker polling intervals, retry behavior, or DLQ behavior.
- Changing the shape of the consolidated internal status API.
