# Iris Document Sync Handled Failure Retry Design

Date: 2026-07-10
Status: v1 reliability hardening

## Goal

Ensure a document fetch failure that the runner records durably still enters
the document-sync queue's bounded retry and dead-letter policy instead of being
acknowledged as successful work.

## Problem

`DocumentSyncRunner.syncSourceById()` deliberately turns Feishu and network
fetch exceptions into a structured `status: "failed"` result after it stores a
failed snapshot and marks the source `failed`. `DocumentSyncWorker` currently
acknowledges every returned result, including `failed`, and only invokes
`handleFailedJob` when the runner throws.

This creates a permanent failure window:

```text
transient Feishu timeout
-> failed snapshot stored
-> source marked failed
-> runner returns status failed
-> worker ACKs job
-> no retry and no DLQ
```

The architecture whitepaper already requires bounded document I/O failures to
flow through queue retry/dead-letter recovery. The older Phase 3E design's
out-of-scope choice for handled failures is therefore superseded for this
specific worker routing rule.

## Approaches Considered

### A. Classify Runner Results In The Worker

After the runner returns, the worker sends `status: "failed"` through the
existing queue failure handler and ACKs only terminal non-failure results.

Advantages:

- preserves the runner's structured result contract for direct callers;
- reuses existing retry limits, atomic Redis retry handling, DLQ management,
  health reporting, and operator APIs;
- requires no schema or service changes.

Trade-off:

- worker processing must distinguish persisted operation failure from terminal
  processed outcomes.

### B. Make The Runner Throw After Recording Failure

This reuses the worker's thrown-error path, but removes the useful distinction
between a durably recorded fetch failure and an unexpected runner crash. It also
changes every direct runner caller.

### C. Add A Failed-Source Scheduler

A periodic scanner could reset and enqueue failed sources, but duplicates the
queue's retry policy, delays recovery, and adds another ownership path.

## Decision

Use Approach A.

`DocumentSyncWorker` classifies the runner result before ACK:

- `failed`: call `queue.handleFailedJob({ job, errorMessage })` through the
  existing bounded failure-handler retry helper and return worker
  `status: "failed"` with `retryAction` and `attempts`;
- `synced`, `skipped`, `rejected`, `not_found`: ACK and return worker
  `status: "processed"` with the runner status.

The runner call and queue failure routing remain separately structured so an
error from `handleFailedJob` is not accidentally caught and submitted to the
same failure handler a second time. Existing handling for runner throws and
processed-job ACK failures remains unchanged.

## Retry State Flow

On a fetch failure, the runner leaves durable failed evidence and source state
`failed`. A requeued job can claim that source again because `failed` is neither
an already-running nor already-completed terminal state. The existing worker
recovery authority then executes the normal policy checks and sync pipeline.

At the configured maximum attempt count, the queue moves the job to DLQ. The
source remains `failed`, the failed snapshots remain available for diagnosis,
and existing internal DLQ APIs allow operator replay.

## Error Handling

- Use the runner result's already bounded `errorMessage` as the queue failure
  reason.
- Preserve the queue failure handler's three local attempts for transient Redis
  errors.
- Do not ACK a handled failed result.
- Do not change queue serialization, idempotency, retry limits, or DLQ format.

## Testing

Worker tests must prove that runner-handled failures:

- do not call `handleProcessedJob`;
- call `handleFailedJob` with the original job and runner error message;
- report both `requeued` and `dead_lettered` actions with attempt counts;
- preserve existing terminal ACK behavior and thrown-error behavior.

Focused tests, type checking, the full repository verification, independent
review, and PR checks remain required before publication.
