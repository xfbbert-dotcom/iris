# Iris Raw Event Queue Seen Release Design

## Context

The raw Feishu event queue uses a Redis seen set to deduplicate callback retries. Before this patch, a valid event kept its idempotency key in the seen set even after `LPOP`. If a worker crashed after dequeueing but before processing, a later callback retry with the same event id could be rejected by the seen set while no queued payload remained.

## Decision

Raw event queues release idempotency keys when valid events are dequeued:

- Redis raw queue calls `SREM` after parsing a valid payload and before returning it to the worker.
- In-memory raw queue removes dequeued keys from its local seen set.

Failed processing still requeues through the worker failure path. Message persistence remains idempotent by Feishu message id, so duplicate callback retries after dequeue are acceptable.

## Scope

- Applies to valid dequeued raw events.
- Invalid payloads still go to DLQ and do not attempt best-effort key recovery.
- Does not change raw event idempotency key construction or processor retry policy.

## Quality Bar

- A dequeued raw event releases its seen key.
- A later retry with the same raw event id can enter the queue again.
- Existing FIFO, invalid payload DLQ, retry, and dead-letter behavior continue to pass.
