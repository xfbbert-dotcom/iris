# Iris Raw Event Requeue Idempotency Design

## Context

Feishu can retry the same callback event while Iris is processing or retrying earlier delivery attempts. Raw event queues already release idempotency keys after dequeue so lost in-flight work can be recovered, but failed-event requeue must claim the idempotency key again or platform retries can duplicate the same event while it is waiting for retry.

## Decision

When a raw event fails below the dead-letter threshold:

- In-memory queues re-add the event idempotency key before appending the retry event.
- Redis queues reuse the atomic `SADD + RPUSH` enqueue script instead of bare `RPUSH`.

## Scope

- Does not change the dead-letter threshold.
- Does not change raw event payload shape.
- Does not add a new retry state or visibility timeout.

## Quality Bar

- A duplicate platform retry after failed-event requeue does not create a second pending in-memory event.
- Redis failed-event requeue is guarded by the same idempotency set as normal enqueue.
- Dequeued idempotency keys are still released before processing so lost in-flight events remain recoverable.
