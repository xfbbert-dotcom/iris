# Iris Raw Event Queue ACK Design

## Problem

The Feishu gateway returns HTTP 200 as soon as a raw event is enqueued. After that point Feishu may not retry the callback. The Redis raw event queue currently removes an event from the pending list during `dequeueBatch`. If the worker process crashes after dequeue and before processing finishes, the event can be silently lost.

## Root Cause

`RedisRawEventQueue.dequeueBatch` uses `LPOP` on the pending queue and releases the idempotency key immediately. There is no success acknowledgement step. The worker also has no way to tell the queue that processing completed.

## Desired Behavior

- Dequeued raw events remain claimed until the worker explicitly acknowledges successful processing.
- Successful processing removes the event from the in-flight area and releases its idempotency key.
- Failed processing removes the in-flight copy and uses the existing retry/dead-letter policy.
- Redis queues recover any abandoned in-flight raw events before polling pending work, so a worker restart does not strand events forever.
- The gateway-facing API remains unchanged: it only needs `enqueue`.

## Scope

This patch originally hardened the raw Feishu event queue. The same ACK/processing-list pattern now
also applies to document sync and document reindex queues.

The v1 processing-list recovery model is single-consumer only. It protects a crashed worker in the
internal rollout shape, but it is not a lease-based multi-replica queue.
