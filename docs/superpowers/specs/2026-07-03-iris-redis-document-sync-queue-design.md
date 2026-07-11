# Iris Redis Document Sync Queue Design

Date: 2026-07-03
Status: Phase 3B design

## Goal

Phase 3B replaces the local-only document sync queue composition with a Redis-backed queue implementation that can be shared by the Feishu event worker producer and the document sync worker consumer.

This phase closes the gap left by Phase 3A: document sync jobs can survive process boundaries and service restarts instead of living only inside one runtime instance.

## Scope

In scope:

- Add `createRedisDocumentSyncQueue`.
- Preserve `DocumentSyncQueue`'s existing contract.
- Atomically deduplicate enqueues by `idempotencyKey`.
- Serialize and parse `DocumentSyncJob` payloads with date round-tripping.
- Default old queue payloads without `attempts` to `0`.
- Wire the event worker runtime to use the Redis document sync queue.
- Wire the document sync runtime to use the Redis document sync queue.

Out of scope:

- Retry and dead-letter handling for document sync jobs.
- Admin APIs for document sync queue management.
- Reindex enqueue after successful document sync.
- Persisted job leasing or visibility timeout.

## Redis Keys

Default keys:

- Seen set: `iris:documents:sync:seen`
- Queue list: `iris:documents:sync:queue`

Enqueue uses the same atomic pattern as raw events and reindex jobs:

```text
SADD seen idempotencyKey
if new:
  RPUSH queue serializedJob
else:
  no-op
```

This keeps Feishu retry storms and repeated group document mentions from producing duplicate sync jobs.

## Runtime Wiring

Event worker runtime:

```text
Redis client
-> Redis raw event queue
-> Feishu event processor
-> group-visible document registrar
-> Redis document sync queue producer
```

Document sync runtime:

```text
Redis client
-> Redis document sync queue consumer
-> DocumentSyncWorker
-> DocumentSyncRunner
```

Both runtimes should use `REDIS_URL`, matching the existing event and reindex worker configuration pattern.

## Failure Strategy

The Redis document sync queue remains a simple FIFO queue in this phase. Worker-thrown failures are still reported in `DocumentSyncWorkerLoop.latestBatch`, but failed jobs are not automatically retried or sent to a DLQ yet.

That is intentional: retry/DLQ requires extending `DocumentSyncQueue` and `DocumentSyncWorker` together, and should be a separate phase after Redis sharing is proven.

## Constitutional Alignment

This phase strengthens the async boundary between Feishu event ingestion and document body fetching. It preserves the 3-second gateway rule, keeps heavy document reads out of message ingestion, and makes discovered document sync durable enough for multi-process Iris deployments.
