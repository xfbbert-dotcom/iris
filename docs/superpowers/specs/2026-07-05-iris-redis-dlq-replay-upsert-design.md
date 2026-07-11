# Iris Redis DLQ Replay Upsert Design

## Context

Redis-backed raw event, document sync, and reindex queues use a `seen` set plus a list to prevent
duplicate pending work. Normal enqueue is intentionally deduplicating: if `SADD seen key` returns
`0`, the payload is not pushed.

DLQ replay is different from normal enqueue. It is an operator recovery action. If Redis has a stale
`seen` key with no corresponding queued payload, replaying a DLQ item through the normal enqueue
script can no-op and then delete the DLQ record. The work is then neither in the queue nor in DLQ.

## Decision

Redis DLQ replay must use the retry/upsert enqueue script instead of the normal first-time enqueue
script:

- if the key is not in `seen`, add it and push the replay payload;
- if the key is in `seen` and a queued duplicate exists, replace that queued payload with the replay
  payload;
- if the key is in `seen` but no queued duplicate exists, push the replay payload anyway;
- only remove the DLQ entry after the upsert script completes successfully.

This applies to raw Feishu events, document sync jobs, and document reindex jobs.

## Invariants

- Normal enqueue remains deduplicating and does not replace existing queued work.
- Failed-job retry behavior remains unchanged.
- Replay still resets attempts to `0`.
- Replay of invalid raw payload or legacy DLQ diagnostics remains unsupported.
- If Redis eval throws, the DLQ entry remains in place.

## Out Of Scope

- Adding leases or in-flight ownership.
- Changing Redis key names.
- Changing DLQ payload schemas.
