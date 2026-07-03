# Iris Worker Loop onError Isolation Design

## Context

Raw event, document sync, and document reindex worker loops catch `processBatch` failures, record a failed batch snapshot, and call an optional `onError` hook. That hook is observability glue and may be supplied by app/runtime code. If the hook itself throws, the loop tick can reject after the original batch failure was already handled, creating avoidable unhandled rejections and weakening worker resilience.

## Decision

Treat `onError` as best-effort observability:

- Batch failure snapshots must still be recorded.
- `onError` should still be called with the original error.
- Exceptions thrown by `onError` must be swallowed inside the loop.
- The loop must continue scheduling later ticks after both the batch failure and the hook failure.

## Scope

This does not add logging, change worker retry policy, change queue semantics, or change status payloads. It only prevents a failing observer hook from becoming a worker-loop failure.

## Quality Bar

Each worker loop must have a test proving that a throwing `onError` hook does not reject the timer run, preserves the failed batch snapshot, and allows the next polling tick to run.
