# Iris Feishu Gateway Nonblocking Enqueue Design

## Context

Feishu callback delivery has a strict acknowledgement window. Iris already avoids heavy signal filtering in the gateway, but the gateway still began raw queue persistence inside the callback call stack. Even without awaiting Redis, an async queue function can run synchronous serialization before its first `await`. A slow or unusually heavy raw event payload could therefore still hold the HTTP response open and trigger Feishu callback retries.

## Decision

The Feishu Gateway must return the Feishu acknowledgement before starting raw event queue persistence work. For the Redis-backed raw queue path, the gateway schedules enqueue work onto the next event-loop turn, then reports any persistence failures through `onEnqueueError`.

Queue persistence errors are captured through an optional `onEnqueueError` callback. The callback is intentionally outside the Feishu response path so a Redis outage does not turn one callback into repeated Feishu retries.

This is an explicit v1 overload tradeoff: if the process crashes in the tiny window between acknowledgement and the scheduled enqueue, that callback may be lost. The product priority for active Feishu groups is to avoid platform retry storms and keep the gateway responsive; operators see enqueue failures through internal status once scheduled persistence runs.

## Scope

- URL verification and request signature verification still run before acknowledgement.
- Runtime-disabled groups are still acknowledged without queueing.
- Raw event queue writes use acknowledgement-first deferred enqueue.
- Legacy event queue writes remain nonblocking but may start inside the callback call stack; the Redis raw queue is the production path.
- Downstream workers still own signal filtering, document discovery, retries, and DLQ behavior.

## Quality Bar

- A never-settling raw queue enqueue cannot block the HTTP 200 acknowledgement.
- Raw queue enqueue work has not started when `handleCallback()` returns its acknowledgement.
- A rejected raw queue enqueue reports the error through `onEnqueueError`.
- Existing idempotency key construction and runtime gating behavior are unchanged.
