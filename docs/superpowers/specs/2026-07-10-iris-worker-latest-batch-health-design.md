# Iris Worker Latest Batch Health Design

## Goal

Prevent consolidated operator status from reporting a worker as healthy when its most recent polling
batch failed.

## Context

Event, document-sync, and reindex worker loops already record bounded failure details in
`latestBatch` and continue polling. The consolidated `/internal/status` adapters currently derive
worker health only from dead-letter counts and event mention-reply readiness. A Redis, Postgres, or
worker-level failure can therefore leave `latestBatch.status = "failed"` while the component still
appears healthy.

## Considered Approaches

1. Map failed latest batches into consolidated component health. This reuses existing snapshots,
   requires no new storage, and lets the next successful batch recover the component automatically.
2. Change every worker-specific status endpoint so its top-level `ok` represents runtime health.
   This would conflate status-read success with health and contradict the established DLQ status
   design.
3. Add persistent failure counters and alert thresholds. This could distinguish transient from
   repeated failures, but adds state and policy that the first 20-30 person rollout does not need.

## Decision

Use approach 1. In consolidated `/internal/status` only:

- `latestBatch.status = "failed"` makes the worker component `ok: false`;
- the component adds `degradedReason: "latest_batch_failed"`;
- the original `latestBatch`, including its bounded `errorMessage`, remains visible;
- a later successful batch clears this degradation because the loop replaces `latestBatch`;
- a missing `latestBatch` does not degrade a newly started worker.

Health evidence precedence is:

1. non-empty DLQ: `dead_letters_present`;
2. failed latest batch: `latest_batch_failed`;
3. unavailable mention replies on the event worker: `mention_replies_unavailable`.

The worker-specific status endpoints remain unchanged and continue using top-level `ok` to indicate
that status retrieval succeeded.

## Verification

- One consolidated API test must cover event, document-sync, and reindex failed latest batches.
- The test must verify top-level degraded summary counts and each component reason.
- Existing DLQ and mention-reply precedence tests must remain green.
- Full repository verification and GitHub CI must pass.

## Out Of Scope

- Persistent consecutive-failure counters.
- Alert delivery or paging thresholds.
- Changing worker retry and DLQ behavior.
