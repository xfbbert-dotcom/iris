# Iris Reindex Observability Design

Date: 2026-07-02
Status: Phase 2Q proposed design
Product name: Iris

## 1. Purpose

Phase 2P made Iris reindexing operational: the app can compose a Redis/Postgres worker runtime, enqueue missing snapshot/profile work through an internal API, and consume jobs in the background.

Phase 2Q makes that background system observable. Operators need to know whether the worker is enabled, whether it is running, how much work is pending, and what happened in the latest batch.

The selected direction is option C: worker status, queue depth, and latest batch result.

## 2. Design Goals

Phase 2Q must provide:

- an internal `GET /internal/reindex/status` endpoint;
- worker runtime status without requiring manual log inspection;
- Redis queue pending count;
- latest batch result summary from the worker loop;
- latest batch error summary when a poll fails;
- deterministic tests with fake queues and fake workers;
- no new dependency on a real Redis server for unit tests;
- no change to Feishu callback acknowledgement behavior.

The core goal is operational confidence: Iris should be able to answer "is reindexing alive, is it backed up, and what did it just do?"

## 3. Out Of Scope

This phase does not implement:

- UI dashboards;
- historical metrics storage;
- Prometheus/OpenTelemetry export;
- worker pause/resume controls;
- dead-letter queues;
- retry counters;
- queue inspection by job payload;
- public authentication.

These features can layer on top of the status boundary later.

## 4. Status API

Add:

```http
GET /internal/reindex/status
```

When runtime is unavailable:

```json
HTTP 200
{
  "ok": true,
  "enabled": false,
  "running": false
}
```

When runtime is available:

```json
HTTP 200
{
  "ok": true,
  "enabled": true,
  "running": true,
  "activeEmbeddingProfileId": "openai-compatible:text-embedding-small:1536",
  "intervalMs": 1000,
  "batchLimit": 25,
  "pendingJobCount": 42,
  "latestBatch": {
    "status": "succeeded",
    "startedAt": "2026-07-02T09:00:00.000Z",
    "finishedAt": "2026-07-02T09:00:00.120Z",
    "indexedCount": 3,
    "skippedCount": 2,
    "failed": false
  }
}
```

If pending count cannot be read:

```json
HTTP 500
{
  "ok": false,
  "error": "reindex_status_failed"
}
```

The endpoint is internal. It reports state and does not mutate worker behavior.

## 5. Queue Depth

Extend the reindex queue boundary with a small optional operation:

```ts
getPendingCount(): Promise<number>;
```

Implement it for:

- `InMemoryDocumentReindexQueue`: return in-memory job array length;
- `RedisDocumentReindexQueue`: call `LLEN` on the queue key.

The Redis client adapter adds:

```ts
lLen(key: string): Promise<number>;
```

This exposes only the count, not job payloads. Payload inspection stays out of scope.

## 6. Worker Loop Snapshot

Extend `DocumentReindexWorkerLoop` with a snapshot method:

```ts
getSnapshot(): {
  running: boolean;
  intervalMs: number;
  batchLimit: number;
  latestBatch?: ReindexWorkerBatchSnapshot;
};
```

Batch snapshot:

```ts
type ReindexWorkerBatchSnapshot =
  | {
      status: "succeeded";
      startedAt: Date;
      finishedAt: Date;
      indexedCount: number;
      skippedCount: number;
      failed: false;
    }
  | {
      status: "failed";
      startedAt: Date;
      finishedAt: Date;
      indexedCount: 0;
      skippedCount: 0;
      failed: true;
      errorMessage: string;
    };
```

The loop already catches batch errors and continues polling. Phase 2Q records those errors as the latest batch snapshot.

## 7. Runtime Status Boundary

Extend `ReindexWorkerRuntime` with:

```ts
getStatus(): Promise<{
  enabled: true;
  running: boolean;
  activeEmbeddingProfileId: string;
  intervalMs: number;
  batchLimit: number;
  pendingJobCount: number;
  latestBatch?: ReindexWorkerBatchSnapshot;
}>;
```

The app route uses this runtime method. If runtime is missing, the route returns disabled status directly.

Runtime status composes:

```text
loop.getSnapshot()
queue.getPendingCount()
activeEmbeddingProfileId
```

## 8. Error Handling

Queue count errors:

- propagate from runtime `getStatus()`;
- route maps them to `500 reindex_status_failed`.

Loop batch errors:

- remain non-fatal;
- are recorded as `latestBatch.status = "failed"`;
- continue to call the existing `onError` callback.

No status endpoint error should stop the worker loop.

## 9. Testing Strategy

Queue tests:

- in-memory queue pending count increases/decreases with enqueue/dequeue;
- Redis queue calls `lLen` with the queue key.

Loop tests:

- snapshot reports running, interval, and batch limit;
- successful batch records indexed/skipped counts;
- failed batch records error message and keeps running.

Runtime tests:

- `getStatus()` combines active profile, loop snapshot, and queue depth.

Route tests:

- missing runtime returns disabled status;
- available runtime returns status JSON;
- runtime status failure returns `500 reindex_status_failed`.

Final verification must include:

- `npm run typecheck`;
- `npm test`;
- `python -m pytest` from `workers/ai`;
- `docker compose config`.

## 10. Product Impact

After Phase 2Q:

- Iris can report whether reindex worker is enabled and running;
- operators can see Redis backlog without shelling into Redis;
- recent batch results make silent worker failure much easier to diagnose;
- future admin screens can consume a real status API instead of inventing their own runtime probes.
