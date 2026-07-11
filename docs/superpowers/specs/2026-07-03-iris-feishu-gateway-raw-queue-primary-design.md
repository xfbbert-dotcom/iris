# Iris Feishu Gateway Raw Queue Primary Design

## Problem

After wiring the event worker runtime raw queue into the Feishu gateway, the gateway can
write both the Redis-backed raw event queue and the legacy in-memory event queue for the
same callback.

That creates two problems:

- The legacy queue is not consumed by the event worker runtime.
- In a production default app, the in-memory queue can grow with every Feishu callback
  even though Redis is the real processing path.

## Decision

Make the raw event queue the primary ingress path.

Gateway enqueue behavior:

1. If `rawEventQueue` is available, enqueue the callback there.
2. Otherwise, fall back to the legacy `EventQueue`.

The HTTP response contract stays unchanged.

## Non-Goals

- Do not remove the legacy queue type in this patch.
- Do not make enqueue fire-and-forget; Iris still waits for the ingress write to complete
  before acknowledging Feishu.
- Do not move message parsing or signal filtering into the callback path.

## Quality Bar

- With `rawEventQueue`, the legacy queue remains empty.
- Without `rawEventQueue`, existing legacy enqueue behavior remains unchanged.
- Gateway tests continue to cover URL verification, verification rejection, and raw body
  verifier behavior.
