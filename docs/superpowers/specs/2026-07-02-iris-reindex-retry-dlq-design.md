# Iris Reindex Retry and Dead-Letter Design

Date: 2026-07-02
Status: Phase 2R proposed design
Product name: Iris

## 1. Purpose

Phase 2Q made the reindex worker observable. Phase 2R makes it recoverable.

Today, if indexing a job throws because of an embedding API, Redis, Postgres, or transient network failure, the worker loop can record that a batch failed, but the individual job has no standard recovery path. Phase 2R adds bounded retry and dead-letter queue behavior so transient failures can be retried and persistent failures do not loop forever.

The selected direction is option B: retry plus dead-letter queue, without replay API in this phase.

## 2. Design Goals

Phase 2R must provide:

- per-job retry attempts;
- a max-attempts policy;
- dead-letter storage for jobs that exceed max attempts;
- DLQ count in reindex status;
- worker results that show failed jobs and whether they were requeued or dead-lettered;
- no infinite retry loops;
- deterministic tests for in-memory and Redis queue behavior;
- no replay API yet.

The core goal is to keep the background reindex pipeline moving even when individual jobs fail repeatedly.

## 3. Job Attempts

Extend `DocumentReindexJob`:

```ts
attempts: number;
```

Existing serialized jobs without `attempts` parse as `attempts: 0`. This keeps old Redis payloads readable.

Newly created planner jobs set `attempts: 0`.

## 4. Queue Failure Contract

Extend `DocumentReindexQueue`:

```ts
handleFailedJob(input: {
  job: DocumentReindexJob;
  errorMessage: string;
}): Promise<{
  action: "requeued" | "dead_lettered";
  attempts: number;
}>;

getDeadLetterCount(): Promise<number>;
```

The queue owns retry/DLQ policy because it owns the concrete storage mechanism.

Default policy:

```text
maxAttempts = 3
```

Interpretation:

- `attempts` is the number of failed processing attempts already recorded;
- on failure, queue increments attempts;
- if incremented attempts is less than `maxAttempts`, requeue the job;
- if incremented attempts is greater than or equal to `maxAttempts`, move it to DLQ.

So `maxAttempts = 3` means the job can fail three times total, then lands in DLQ.

## 5. Redis Keys

Existing keys:

```text
iris:reindex:documents:queue
iris:reindex:documents:seen
```

New key:

```text
iris:reindex:documents:dlq
```

Redis behavior:

- requeue: `RPUSH queue <job with incremented attempts>`;
- dead-letter: `RPUSH dlq <dead letter payload>`;
- DLQ count: `LLEN dlq`.

Dead-letter payload:

```ts
{
  job: DocumentReindexJob;
  errorMessage: string;
  failedAt: string;
}
```

Phase 2R does not inspect or replay DLQ payloads. It only stores and counts them.

## 6. Worker Failure Handling

Change `DocumentReindexWorker.processBatch()` from all-or-nothing to per-job failure handling.

For each dequeued job:

```text
try process job
  return indexed/skipped
catch error
  queue.handleFailedJob({ job, errorMessage })
  return failed result with action and attempts
```

Add result:

```ts
{
  status: "failed";
  documentSnapshotId: string;
  embeddingProfileId: string;
  reason: "processing_error";
  errorMessage: string;
  retryAction: "requeued" | "dead_lettered";
  attempts: number;
}
```

This prevents one bad job from failing the entire batch.

## 7. Worker Loop Snapshot

Extend successful batch snapshot with `failedCount`:

```ts
{
  status: "succeeded";
  indexedCount: number;
  skippedCount: number;
  failedCount: number;
}
```

A batch with failed jobs but no uncaught batch-level exception is still `status: "succeeded"` because the loop handled those failures and continued.

Batch-level `status: "failed"` remains for unexpected `processBatch()` errors.

## 8. Runtime Status

Extend `ReindexWorkerRuntimeStatus`:

```ts
deadLetterJobCount: number;
```

Status route response includes:

```json
{
  "pendingJobCount": 3,
  "deadLetterJobCount": 1
}
```

If reading DLQ count fails, `GET /internal/reindex/status` returns `500 reindex_status_failed`, same as pending count failures.

## 9. Out Of Scope

This phase does not implement:

- replay API;
- DLQ payload listing;
- retry delay or exponential backoff;
- retry reason classification;
- per-provider rate limit backoff;
- alerting;
- UI.

Those can layer on top of DLQ storage and status counts later.

## 10. Testing Strategy

Queue tests:

- new jobs start with attempts 0;
- parser defaults missing attempts to 0;
- in-memory failed job requeues below max attempts;
- in-memory failed job enters DLQ at max attempts;
- Redis failed job pushes to queue below max attempts;
- Redis failed job pushes to DLQ at max attempts;
- DLQ count returns `LLEN dlq`.

Worker tests:

- processing errors produce failed results;
- failed jobs are requeued below max attempts;
- failed jobs are dead-lettered at max attempts;
- one failed job does not stop later jobs in the same batch.

Loop tests:

- successful batch snapshot includes `failedCount`.

Runtime/status tests:

- runtime status includes `deadLetterJobCount`.
- status API returns that count.

Final verification:

- `npm run typecheck`;
- `npm test`;
- `python -m pytest` from `workers/ai`;
- `docker compose config`.

## 11. Product Impact

After Phase 2R:

- transient reindex failures retry automatically;
- persistent failures stop clogging the main queue;
- operators can see DLQ count from the internal status endpoint;
- future Phase 2S can add DLQ replay/listing without changing the worker contract again.
