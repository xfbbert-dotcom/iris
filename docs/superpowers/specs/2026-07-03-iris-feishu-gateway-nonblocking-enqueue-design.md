# Iris Feishu Gateway Nonblocking Enqueue Design

## Context

Feishu callback delivery has a strict acknowledgement window. Iris already avoids heavy signal filtering in the gateway, but the gateway still awaited raw event queue persistence. A slow Redis connection or delayed queue write could hold the HTTP response open and trigger Feishu callback retries.

## Decision

The Feishu Gateway must start raw event persistence and return the Feishu acknowledgement without waiting for the queue write to settle.

Queue persistence errors are captured through an optional `onEnqueueError` callback. The callback is intentionally outside the Feishu response path so a Redis outage does not turn one callback into repeated Feishu retries.

## Scope

- URL verification and request signature verification still run before acknowledgement.
- Runtime-disabled groups are still acknowledged without queueing.
- Raw event queue writes and legacy event queue writes both use nonblocking enqueue.
- Downstream workers still own signal filtering, document discovery, retries, and DLQ behavior.

## Quality Bar

- A never-settling raw queue enqueue cannot block the HTTP 200 acknowledgement.
- A rejected raw queue enqueue reports the error through `onEnqueueError`.
- Existing idempotency key construction and runtime gating behavior are unchanged.
