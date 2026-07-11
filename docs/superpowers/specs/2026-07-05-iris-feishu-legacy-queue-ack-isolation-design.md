# Iris Feishu Legacy Queue Ack Isolation Design

## Context

Feishu callbacks have a strict acknowledgement budget. The primary Redis raw-event queue path already schedules queue persistence after the gateway has produced the HTTP 200 response.

The legacy `EventQueue` fallback still started `enqueueRawFeishuEvent` inside `handleCallback` before returning. Even though the current in-memory adapter is cheap, that created a hidden reliability split: local or degraded deployments could reintroduce synchronous queue work on the Feishu callback path.

## Decision

Feishu Gateway must schedule both queue backends after acknowledgement:

- Redis `RawEventQueue.enqueue`;
- legacy `EventQueue.enqueueRawFeishuEvent`.

The gateway may still derive bounded idempotency keys and lightweight metadata before the response, but queue persistence work must not begin until the next asynchronous turn.

## Guarantees

- Valid callbacks return `{ ok: true }` before either queue adapter starts persistence work.
- Legacy idempotency behavior is preserved after the deferred enqueue runs.
- Queue persistence failures remain isolated through the existing enqueue-error observer.
- Disabled runtime scopes still acknowledge and skip enqueueing.

## Non-Goals

- Changing Feishu request verification.
- Changing raw-event worker processing.
- Replacing the legacy queue with Redis in tests.
