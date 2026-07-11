# Iris Redis Queue Seen Release Design

## Context

Document sync and document reindex queues use idempotency keys to avoid duplicate pending work. Redis queues store those keys in a `seen` set during enqueue, but previously they did not release the key after a job was dequeued.

That makes the key behave like permanent history instead of a pending-work guard. Over time, a completed document sync or reindex job could block a later legitimate enqueue for the same source or snapshot.

## Decision

Queue idempotency keys represent currently pending work, not completed history:

- Redis sync and reindex queues remove a valid job idempotency key from the `seen` set when the job is dequeued.
- Failed-job retries and DLQ replay use the same atomic `SADD + RPUSH` enqueue script, so requeued jobs reclaim their pending key.
- The in-memory reindex queue mirrors this lifecycle by deleting the key on dequeue and re-adding it when failed or replayed jobs are queued again.

## Scope

This does not change raw Feishu event deduplication. Raw event idempotency remains history-like because Feishu can retry the exact same event and Iris must not process it twice.

This also does not add durable job-completion tracking. It only fixes the pending-work dedupe lifecycle for document sync and document reindex queues.

## Quality Bar

- Completed document sync jobs can be enqueued again later when the source needs fresh sync.
- Completed document reindex jobs can be enqueued again later when reindexing is requested again.
- Failed retries remain deduplicated while they are pending.
- Redis and in-memory queue behavior stays aligned for document indexing pipelines.
