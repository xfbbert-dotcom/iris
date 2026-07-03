# Iris Redis Raw Event Invalid Payload DLQ Design

## Problem

`RedisRawEventQueue.dequeueBatch` pops payloads from Redis and immediately parses them.
If a queued payload is malformed JSON or otherwise invalid, parsing throws. The worker
batch fails, and the already-popped payload is neither processed nor recorded in the DLQ.

For an internal deployment, this makes troubleshooting harder and can interrupt raw event
processing because one bad queue entry aborts the whole batch.

## Decision

When `dequeueBatch` cannot parse a popped payload, push a compact invalid-payload record
to the raw event DLQ and continue dequeuing.

DLQ record shape:

```json
{
  "rawPayload": "{",
  "errorMessage": "Invalid raw event JSON",
  "failedAt": "2026-07-03T12:00:00.000Z"
}
```

Valid payloads in the same batch are still returned to the worker.

## Non-Goals

- Do not retry invalid queue payloads; they cannot be processed as `RawEvent`.
- Do not change the normal failed-event retry/DLQ policy.
- Do not alter Redis queue key names.

## Quality Bar

- A malformed payload is recorded in the raw event DLQ.
- Valid events after a malformed payload in the same batch are still returned.
- Existing enqueue, retry, and max-attempt DLQ behavior remains unchanged.
