# Iris Redis Reindex Worker Design

Date: 2026-07-02
Status: Phase 2O proposed design
Product name: Iris

## 1. Purpose

Phase 2N gave Iris an asynchronous document reindex boundary, but its queue implementation is in-memory. That is useful for deterministic tests and local development, but it is not durable. If the service restarts, pending reindex jobs disappear.

Phase 2O upgrades this path to a Redis-backed queue and adds an automatic worker polling loop. After this phase, Iris can enqueue document/profile reindex work into Redis and process it outside request paths without manual batch calls.

The selected direction is option B: Redis queue plus worker automatic polling entrypoint.

## 2. Design Goals

Phase 2O must provide:

- a `RedisDocumentReindexQueue` that implements the existing `DocumentReindexQueue` interface;
- durable pending jobs across service restarts;
- queue-level deduplication by existing reindex idempotency key;
- FIFO batch dequeue behavior;
- a startable/stoppable `DocumentReindexWorkerLoop`;
- bounded batch size and polling interval configuration;
- failure isolation so one failed worker batch does not kill the loop;
- test coverage that does not require a real Redis server;
- no model, embedding, or Redis blocking work in Feishu callback acknowledgement paths.

The core product goal is to make document embedding backfill operational and automatic while preserving the fast gateway architecture.

## 3. Out Of Scope

This phase does not implement:

- BullMQ or another heavy queue framework;
- distributed lock leadership;
- dead-letter queues;
- retry counters or exponential backoff;
- admin UI for worker status;
- progress dashboards;
- automatic event-to-document-sync wiring;
- Feishu permission refresh during reindex;
- multiple named reindex queues per tenant.

Those should attach later to the queue and worker-loop boundaries.

## 4. Redis Queue Model

The existing job contract remains unchanged:

```ts
export type DocumentReindexJob = {
  idempotencyKey: string;
  embeddingProfileId: string;
  documentSnapshotId: string;
  reason: "document_synced" | "manual_profile_reindex";
  enqueuedAt: Date;
};
```

Redis keys:

```text
iris:reindex:documents:queue
iris:reindex:documents:seen
```

The queue key is a Redis List. The seen key is a Redis Set of idempotency keys.

Enqueue semantics:

```text
if SADD seen <idempotencyKey> returns 1:
  RPUSH queue <serialized job>
else:
  do nothing
```

This preserves the Phase 2N invariant: one snapshot/profile pair should not be queued more than once because of retries.

Dequeue semantics:

```text
repeat up to limit:
  LPOP queue
  parse job
  return parsed jobs
```

This is intentionally simple. Phase 2O does not implement visibility timeout. If the process crashes after `LPOP` and before indexing, that job may be lost. This is acceptable for this phase because manual profile planning can re-enqueue missing snapshot/profile pairs, and the worker remains idempotent. A future phase can move to Redis Streams or reliable list transfer if the product requires stronger delivery guarantees.

## 5. Redis Client Boundary

Add a narrow Redis client adapter rather than importing a concrete Redis package throughout the domain code.

The reindex queue only needs:

```ts
type RedisReindexQueueClient = {
  sAdd(key: string, member: string): Promise<number>;
  rPush(key: string, value: string): Promise<number>;
  lPop(key: string): Promise<string | null>;
};
```

This keeps unit tests lightweight. Production wiring can adapt the `redis` package client to this shape.

The TypeScript workspace currently has no Redis dependency. Phase 2O should add the official `redis` npm package to `apps/core`.

## 6. Serialization

Redis stores JSON strings. Dates serialize as ISO strings and deserialize back to `Date`.

Serialization rules:

- reject non-object payloads;
- reject missing or empty string fields;
- reject unknown `reason` values;
- reject invalid `enqueuedAt`;
- return a clear parse error for malformed queue values.

Malformed queue entries are exceptional in Phase 2O. The loop logs the error and continues future polls, but the queue implementation should throw when a popped value cannot be parsed.

## 7. Worker Loop

Add `DocumentReindexWorkerLoop` as a thin orchestrator around the existing `createDocumentReindexWorker`.

Public API:

```ts
type DocumentReindexWorkerLoop = {
  start(): void;
  stop(): Promise<void>;
  isRunning(): boolean;
};
```

Dependencies:

```ts
type DocumentReindexWorkerLoopDependencies = {
  worker: {
    processBatch(input: { limit: number }): Promise<DocumentReindexJobResult[]>;
  };
  intervalMs: number;
  batchLimit: number;
  onError?: (error: unknown) => void;
  setTimeout?: typeof globalThis.setTimeout;
  clearTimeout?: typeof globalThis.clearTimeout;
};
```

Loop behavior:

```text
start()
-> if already running, do nothing
-> schedule tick

tick
-> call worker.processBatch({ limit: batchLimit })
-> if it throws, call onError(error)
-> if still running, schedule next tick after intervalMs

stop()
-> mark stopped
-> clear pending timer
-> wait for any in-flight tick to finish
```

The loop must not run batches concurrently. If a batch takes longer than the interval, the next tick is scheduled only after the current batch finishes.

## 8. Runtime Configuration

Add environment-backed config:

```text
REDIS_URL=redis://localhost:6379
IRIS_REINDEX_WORKER_ENABLED=false
IRIS_REINDEX_WORKER_INTERVAL_MS=1000
IRIS_REINDEX_WORKER_BATCH_LIMIT=25
```

Defaults:

- `IRIS_REINDEX_WORKER_ENABLED=false`;
- `IRIS_REINDEX_WORKER_INTERVAL_MS=1000`;
- `IRIS_REINDEX_WORKER_BATCH_LIMIT=25`;
- `REDIS_URL` defaults to `redis://localhost:6379` when Redis-backed runtime is explicitly enabled.

Validation:

- interval must be a positive integer;
- batch limit must be a positive integer;
- Redis URL must be present when Redis queue runtime is enabled.

The worker is opt-in. Local tests and app startup should not require Redis unless the worker is enabled.

## 9. Runtime Wiring

Add a small runtime composer for reindex worker dependencies.

Conceptual flow:

```text
read reindex worker config
if disabled:
  return undefined
create Redis client
create RedisDocumentReindexQueue
compose existing snapshot repository, fragment repository, semantic indexer
create DocumentReindexWorker
create DocumentReindexWorkerLoop
return { loop, close }
```

App startup:

```text
buildApp()
-> compose reindex worker runtime if enabled
-> start loop after Fastify app is built
-> stop loop and close Redis/Postgres clients on app close
```

Phase 2O may keep full semantic indexer runtime composition minimal if some dependencies are not yet centrally available. The important requirement is that the loop component and Redis queue are implemented and tested, and that runtime config has a clear opt-in boundary.

## 10. Error Handling

Queue errors:

- `enqueue` propagates Redis errors to its caller;
- `dequeueBatch` propagates Redis and parse errors.

Loop errors:

- catch errors from `worker.processBatch`;
- call `onError` if provided;
- continue polling after the configured interval;
- do not throw out of the timer callback.

Stop behavior:

- `stop()` should be safe before `start()`;
- repeated `start()` calls should not create duplicate loops;
- repeated `stop()` calls should be safe;
- `stop()` waits for the in-flight batch promise to settle.

## 11. Testing Strategy

Unit tests should cover Redis queue behavior with a fake client:

- `enqueue` pushes a job only when `sAdd` reports a new idempotency key;
- duplicate enqueue does not call `rPush`;
- `dequeueBatch` returns jobs in FIFO order;
- `dequeueBatch` respects limit;
- job serialization restores `Date`;
- malformed JSON throws a clear error.

Unit tests should cover worker loop behavior with fake timers:

- `start()` runs `processBatch` automatically;
- repeated `start()` does not duplicate polling;
- `stop()` prevents future ticks;
- thrown batch errors call `onError` and do not stop future polling;
- no overlapping batches occur.

Config tests should cover:

- disabled by default;
- enabled parses Redis URL, interval, and batch limit;
- invalid interval fails;
- invalid batch limit fails.

Final verification must include:

- `npm run typecheck`;
- `npm test`;
- `python -m pytest` from `workers/ai`;
- `docker compose config`.

## 12. Product Impact

After Phase 2O:

- Iris can keep reindex jobs in Redis instead of process memory;
- reindex work can progress automatically in the background;
- service restarts no longer erase queued jobs;
- the Feishu gateway remains fast and isolated;
- the later admin UI can observe or control a real background process rather than a manual-only worker.

This is the first production-shaped background worker for Iris, so it should remain deliberately small and easy to reason about.
