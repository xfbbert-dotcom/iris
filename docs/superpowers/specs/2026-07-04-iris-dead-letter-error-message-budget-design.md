# Iris Dead Letter Error Message Budget Design

## Goal

Prevent oversized worker error messages from bloating dead-letter queues and operator diagnostics.

## Architecture

Add `normalizeDeadLetterErrorMessage` as the shared queue-layer error message boundary. The helper:

- Trims short error messages.
- Falls back to `unknown error` for blank messages.
- Truncates oversized messages to `1000` characters with ` ... [truncated]`.

The helper is used by raw event, document sync, and document reindex queues in both Redis and
in-memory implementations. Redis queues apply it when writing newly failed jobs/events, when
dead-lettering invalid queued payloads, and when reading existing DLQ entries back for operators.

## Invariants

- Existing short DLQ error messages remain unchanged.
- Queue retry and replay behavior is unchanged.
- Legacy DLQ entries remain readable, but oversized legacy error messages are bounded when listed.
- Invalid queued/dead-letter payload diagnostics keep their existing short messages.

## Out Of Scope

- Redacting secret patterns inside error messages.
- Bounding raw payloads stored in DLQ diagnostics.
- Changing max retry attempts or replay/delete behavior.
- Changing document snapshot failure error storage.
