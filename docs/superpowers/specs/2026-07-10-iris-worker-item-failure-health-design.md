# Iris Worker Item Failure Health Design

## Problem

Event, document-sync, and reindex worker loops use `latestBatch.status = "succeeded"` to mean the
batch invocation completed without throwing. Individual items can still fail, be requeued, or move
toward dead-lettering; those outcomes are recorded in `latestBatch.failedCount`.

Consolidated `/internal/status` currently degrades workers only for a non-empty DLQ or
`latestBatch.status = "failed"`. A batch with `status = "succeeded"` and `failedCount > 0` therefore
appears healthy. During retry windows, repeated model, Feishu API, Postgres, or indexing failures can
stay invisible until the item finally reaches DLQ.

## Decision

Promote item failures from the latest completed batch into consolidated worker health.

- A latest batch with `failedCount > 0` makes the worker component `ok: false`.
- The stable reason is `latest_batch_items_failed`.
- The original `latestBatch` remains visible so operators can see the failed count and throughput.
- A later completed batch with `failedCount = 0` clears this degradation.
- A missing latest batch remains healthy for a newly started worker.
- Worker-specific status endpoints keep their current status-read semantics.
- Queue retries, retry limits, dead-letter behavior, and worker-loop snapshot types do not change.

Health evidence precedence becomes:

1. non-empty DLQ: `dead_letters_present`;
2. batch invocation failure: `latest_batch_failed`;
3. one or more item failures in the latest completed batch: `latest_batch_items_failed`;
4. unavailable mention replies on the event worker: `mention_replies_unavailable`.

## Alternatives Rejected

### Wait until dead-lettering

This avoids transient degradation but hides the only early signal that real work is repeatedly
failing. For the initial 20-30 person rollout, operator transparency is more valuable than a quiet
green status.

### Consecutive-failure thresholds

Thresholds and rolling windows could reduce noise, but they require persistent counters and policy
configuration. The latest-batch snapshot already supports automatic recovery without new state.

### Mark the batch status itself as failed

That would blur two distinct conditions: the worker loop failed to complete the batch, versus the
batch completed and handled one or more item failures through normal retry policy. Keeping separate
reasons preserves useful diagnosis.

## Quality Bar

- All three worker components degrade on `failedCount > 0` with zero dead letters.
- DLQ and whole-batch failure reasons keep higher precedence.
- Event mention-reply unavailability keeps lower precedence.
- A later zero-failure batch restores health.
- Existing worker-specific status responses remain unchanged.
- Focused tests, full verification, and GitHub CI pass.
