# Iris Async Reindex Queue Design

Date: 2026-07-02
Status: Phase 2N approved design
Product name: Iris

## 1. Purpose

Phase 2N gives Iris a background path for filling embeddings for a target profile.

Phase 2M made 6-dimensional and 1536-dimensional vectors physically storable and searchable in separate pgvector tables. That is necessary but not sufficient: a newly configured 1536-dimensional profile will search an empty table until document snapshots are indexed for that profile. Phase 2N introduces an asynchronous reindex queue and worker so Iris can enqueue snapshot/profile indexing work and process it outside the request path.

The selected product direction is Redis-backed asynchronous batch reindexing. Phase 2N implements the queue, planner, and worker semantics with an in-memory queue driver because the current TypeScript workspace does not yet include a Redis client dependency. A later phase can add the Redis driver without changing the worker contract.

## 2. Design Goals

Phase 2N must provide:

- a queue boundary for document reindex jobs;
- a deterministic in-memory queue implementation for tests;
- a Redis-compatible queue contract for production wiring in the next phase;
- an idempotent reindex worker;
- a planner that finds successful snapshots missing embeddings for a target profile;
- a way to enqueue reindex jobs after document sync success;
- a manual/internal trigger path for enqueueing profile reindex jobs;
- no model or embedding calls in HTTP request acknowledgement paths;
- explicit skip results when work is already complete.

The core goal is to make 1536-dimensional profile rollout operational without blocking chat or Feishu callback flows.

## 3. Out Of Scope

This phase does not implement:

- a visual admin progress UI;
- distributed worker autoscaling;
- complex retry backoff policies;
- dead-letter queues;
- reindex cancellation;
- multi-tenant rate limits;
- Feishu live permission API calls;
- automatic parser upgrades or document refetching.

Those features should attach to the queue and worker boundaries later.

## 4. Job Contract

Add a reindex job payload:

```ts
export type DocumentReindexJob = {
  idempotencyKey: string;
  embeddingProfileId: string;
  documentSnapshotId: string;
  reason: "document_synced" | "manual_profile_reindex";
  enqueuedAt: Date;
};
```

Idempotency key:

```text
reindex:<embeddingProfileId>:<documentSnapshotId>
```

The queue must deduplicate by idempotency key. Feishu already retries callback events, and future sync workers may retry snapshot sync. Reindexing must not create duplicate jobs for the same snapshot/profile pair.

## 5. Queue Boundary

Add a new queue interface rather than overloading the Feishu event queue:

```ts
export interface DocumentReindexQueue {
  enqueue(job: DocumentReindexJob): Promise<void>;
  dequeueBatch(limit: number): Promise<DocumentReindexJob[]>;
}
```

Implementations:

- `InMemoryDocumentReindexQueue` for tests and local development;
- `RedisDocumentReindexQueue` in a later phase after selecting and installing a Redis client dependency.

The interface should stay small. Visibility timeout, retries, and dead-letter queues are intentionally deferred.

## 6. Reindex Planner

The planner finds successful snapshots that need embeddings for a target profile.

Inputs:

```ts
type PlanDocumentReindexInput = {
  embeddingProfileId: string;
  limit: number;
  reason: "manual_profile_reindex";
};
```

Repository query:

```text
successful document_snapshots
where no document_fragments row exists for snapshot id and embedding_profile_id
limit N
```

The planner should not embed anything. It only emits jobs.

Planner result:

```ts
type DocumentReindexPlanResult = {
  enqueuedCount: number;
  skippedCount: number;
};
```

## 7. Sync Integration

When document sync succeeds, Iris should be able to enqueue reindex work for one active profile:

```text
document sync success
-> snapshot created
-> enqueue reindex:<activeProfileId>:<snapshotId>
-> return sync success
```

This must be non-blocking relative to Feishu callback acknowledgement. The Feishu gateway still enqueues raw events and returns 200 quickly; reindex planning happens in downstream async processing or explicit internal calls, not inside gateway acknowledgement.

For Phase 2N, sync integration can be represented as a small helper that accepts a synced snapshot and active profile id. Full automatic event-to-sync-to-reindex wiring may remain a later phase if the current app does not yet have a persistent event worker.

## 8. Reindex Worker

Worker flow:

```text
dequeue batch
-> for each job
-> load embedding profile
-> load document snapshot
-> if snapshot is not succeeded, skip
-> if fragments already exist for snapshot/profile, skip
-> call DocumentSemanticIndexer with embeddingProfileId
-> return indexed/skipped result
```

The worker must be idempotent. The existence check before indexing is mandatory.

Worker result:

```ts
type DocumentReindexJobResult =
  | { status: "indexed"; documentSnapshotId: string; embeddingProfileId: string; fragmentCount: number }
  | { status: "skipped"; documentSnapshotId: string; embeddingProfileId: string; reason: "already_indexed" | "snapshot_not_successful" | "snapshot_not_found" };
```

## 9. Repository Additions

Add narrow repository methods instead of making the worker know SQL details.

Snapshot repository:

```ts
findSnapshotById(id: string): Promise<DocumentSnapshot | undefined>;
listSuccessfulSnapshotsMissingProfile(input: {
  embeddingProfileId: string;
  limit: number;
}): Promise<DocumentSnapshot[]>;
```

Fragment repository:

```ts
hasFragmentsForSnapshotProfile(input: {
  documentSnapshotId: string;
  embeddingProfileId: string;
}): Promise<boolean>;
```

These methods let the planner and worker stay small and testable.

## 10. Internal Trigger

Add an internal trigger service function:

```text
planDocumentProfileReindex(input)
```

Request:

```json
{
  "embeddingProfileId": "openai-compatible:text-embedding-small:1536",
  "limit": 100
}
```

Response:

```json
{
  "ok": true,
  "enqueuedCount": 42,
  "skippedCount": 0
}
```

The HTTP route `POST /internal/reindex/document-profile` is deferred. The important Phase 2N boundary is the planner and queue; exposing it over HTTP can happen after the service function has deterministic test coverage.

## 11. Error Handling

Phase 2N should fail explicitly when:

- embedding profile does not exist;
- queue enqueue fails;
- planner receives an invalid limit;
- worker cannot load the snapshot;
- worker cannot load the profile;
- indexer throws during embedding or persistence.

Worker errors should be visible to the caller of the worker loop. Retry policy is deferred, so failures should not be swallowed.

## 12. Testing Strategy

Unit tests should cover:

- queue deduplicates by idempotency key;
- planner enqueues missing successful snapshots;
- planner does not enqueue snapshots already indexed for the profile;
- worker skips missing snapshots;
- worker skips failed snapshots;
- worker skips already indexed snapshots;
- worker calls `DocumentSemanticIndexer` for missing successful snapshot/profile pairs;
- sync success helper enqueues a `document_synced` reindex job;
- internal trigger validates request shape and enqueues jobs through planner.

Final verification must include:

- `npm run typecheck`;
- `npm test`;
- `python -m pytest` from `workers/ai`;
- `docker compose config`.

## 13. Future Integration Points

Phase 2O can add Redis production driver details:

- Redis list or stream implementation;
- visibility timeout;
- retry counter;
- dead-letter queue;
- worker health metrics.

Phase 2P can add admin progress:

- profile coverage per snapshot/source;
- reindex progress endpoint;
- pause/resume controls.

Recommended next phase after 2N:

> Add a production Redis driver and a long-running worker process entrypoint once the planner and worker semantics are stable under deterministic tests.
