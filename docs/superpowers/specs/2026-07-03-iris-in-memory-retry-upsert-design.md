# Iris In-Memory Retry Upsert Design

## Context

In the v1 in-memory queues, duplicate work can be re-enqueued while a worker is still processing the original item because idempotency keys are released on dequeue for recoverability. If the in-flight item then fails, appending another retry can either duplicate pending work or leave an older pending duplicate at attempt zero.

## Decision

Failed-item requeue in in-memory queues should upsert by idempotency key:

- If no pending item exists, append the retry and claim the key.
- If a pending duplicate already exists, replace that pending item with the failed retry carrying the incremented attempt count.

## Scope

- Applies to in-memory raw event and document reindex queues.
- Does not change Redis queue semantics.
- Does not change dead-letter thresholds or payload shapes.

## Quality Bar

- Raw event retries do not preserve an older platform duplicate at attempt zero.
- Document reindex retries do not create duplicate pending jobs after replanning races.
- FIFO position of an already-pending duplicate is preserved while its retry payload is upgraded.
