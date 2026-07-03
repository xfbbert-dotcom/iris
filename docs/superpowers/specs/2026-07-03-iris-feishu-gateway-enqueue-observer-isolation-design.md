# Iris Feishu Gateway Enqueue Observer Isolation Design

## Context

Feishu Gateway acknowledges callbacks before waiting for queue persistence. When queue persistence fails, it calls an optional `onEnqueueError` hook so app/runtime code can record operational status. That hook is observability glue. If it throws, Iris can turn a handled queue failure into an unhandled rejection after the Feishu callback has already been acknowledged.

## Decision

Treat `onEnqueueError` as best-effort observability:

- Feishu callbacks must still return HTTP 200 for valid events even when queue persistence fails asynchronously.
- `onEnqueueError` should still receive the original enqueue error.
- Exceptions thrown by `onEnqueueError` must be swallowed inside the gateway error reporting path.
- A failing observer must not create an unhandled rejection or affect later callback handling.

## Scope

This does not change queue retry policy, dead-letter policy, callback verification, raw event idempotency, or status snapshot fields. It only isolates observer failures from the ack-first gateway control flow.

## Quality Bar

Gateway tests must prove that a rejected raw queue enqueue reports the original error and that a throwing `onEnqueueError` observer does not break callback acknowledgement or escape as an unhandled rejection.
