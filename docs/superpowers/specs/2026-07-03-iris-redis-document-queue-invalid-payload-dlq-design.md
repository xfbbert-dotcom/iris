# Iris Redis Document Queue Invalid Payload DLQ Design

## Problem

`RedisDocumentSyncQueue.dequeueBatch` and `RedisDocumentReindexQueue.dequeueBatch`
pop payloads from Redis and parse them immediately. If a queued payload is malformed
JSON or fails validation, the batch throws after the bad payload has already been
popped. In a live deployment, one corrupted Redis entry can interrupt document sync
or reindex processing and hide the bad payload from operators.

Raw event Redis queues already dead-letter malformed popped payloads and keep
dequeueing. Document queues should follow the same resilience pattern.

## Decision

When a document sync or document reindex queue cannot parse a popped payload, push
a compact invalid-payload record to that queue's DLQ and continue dequeuing.

DLQ record shape:

```json
{
  "rawPayload": "{",
  "errorMessage": "Invalid document sync job JSON",
  "failedAt": "2026-07-03T12:30:00.000Z"
}
```

Invalid-payload DLQ records are diagnostic only and are not replayable because they
cannot be safely converted into typed jobs.

## Non-Goals

- Do not retry invalid queue payloads.
- Do not change normal failed-job retry or stable-id DLQ behavior.
- Do not change Redis key names or the public queue interfaces.
- Do not make invalid raw payloads replayable.

## Quality Bar

- Document sync Redis dequeue dead-letters invalid payloads and returns later valid jobs.
- Document reindex Redis dequeue dead-letters invalid payloads and returns later valid jobs.
- Existing enqueue, retry, stable-id DLQ, replay, and delete behavior remains unchanged.
