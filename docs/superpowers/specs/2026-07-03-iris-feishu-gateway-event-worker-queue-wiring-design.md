# Iris Feishu Gateway Event Worker Queue Wiring Design

## Problem

`buildApp()` starts the event worker runtime, and that runtime creates the Redis-backed
raw event queue consumed by the worker loop. The Feishu gateway, however, only receives
an explicitly injected `rawEventQueue`. In the default app path, the gateway can write
the legacy in-memory queue while the worker waits on its own Redis queue.

That breaks the core ingestion path: Feishu callbacks can return HTTP 200 without the
event worker ever seeing the raw event.

## Decision

Expose the runtime-created raw event queue from `EventWorkerRuntime` as an optional
`rawEventQueue` property, and wire `buildApp()` so the gateway uses:

1. explicitly injected `dependencies.rawEventQueue`;
2. otherwise, `eventWorkerRuntime.rawEventQueue`;
3. otherwise, the legacy `EventQueue` path.

The runtime already owns the queue, so this does not add a second Redis client or a
second queue implementation.

## Non-Goals

- Do not remove the legacy `EventQueue` yet; existing tests and compatibility paths still
  use it.
- Do not change the gateway ACK response contract.
- Do not move event processing back into the HTTP callback path.

## Quality Bar

- A default app route with an enabled event worker runtime enqueues Feishu callbacks into
  the runtime raw event queue.
- Explicitly injected raw queues still take precedence.
- Existing URL verification and signature rejection behavior remains unchanged.
