# Iris Discovered Document Sync Enqueue Design

Date: 2026-07-03
Status: Phase 2X design

## Goal

Phase 2X closes the lightweight loop from group document discovery to downstream document synchronization. When Iris discovers and registers a group-visible document link from a Feishu group message, it should enqueue a document sync job for the registered source if that source is eligible.

This phase does not fetch Feishu document bodies. It creates the queue contract and producer path so a later worker can consume source IDs and run the existing document sync runner.

## Scope

In scope:

- Add a document sync queue contract for source-level sync jobs.
- Add an in-memory queue implementation for tests and local composition.
- Add a discovered-document sync planner that accepts registered `DocumentSource` objects and enqueues eligible ones.
- Trigger the planner from `GroupVisibleDocumentRegistrar` after registration.
- Wire the planner into the event worker runtime.

Out of scope:

- Redis-backed document sync queue.
- A document sync worker loop.
- Feishu API body fetching.
- Snapshot writing from the event worker.
- Reindexing document fragments after sync.

## Queue Contract

Add `DocumentSyncQueue`.

The job should include:

- `idempotencyKey`: `document-sync:<documentSourceId>`
- `documentSourceId`
- `reason`: initially `discovered_group_document`
- `enqueuedAt`
- `attempts`

The queue must deduplicate jobs by `idempotencyKey`. In-memory v1 should keep this simple with a `Map`.

Redis durability is intentionally deferred. Phase 2X proves the producer-side product behavior without prematurely adding another production queue implementation.

## Eligibility

The planner uses the existing `isSyncCandidate(source)` rule from `document-sync-pipeline.ts`.

Eligible:

- `syncState = pending`
- `permissionState != denied`
- `canUseForAnswering` or `canUseForKnowledgeDrafts`

Not eligible:

- already `syncing`
- already `synced`
- permission denied
- both usage capabilities disabled

This means repeated Feishu messages or retried events will not create unnecessary sync jobs for sources that are already being processed or complete.

## Registrar Integration

`GroupVisibleDocumentRegistrar` currently registers discovered links. Phase 2X extends it with an optional `syncPlanner`.

Flow:

```text
register discovered link
-> registry.registerGroupVisibleDocument(...)
-> syncPlanner.planRegisteredSources([registeredSource])
```

If the planner throws, registration processing should fail so the raw event worker retry/DLQ path can preserve consistency. Silent failure would leave a source registered but never scheduled.

## Runtime Wiring

Event worker runtime should create:

- document source registry;
- document sync queue;
- discovered-document sync planner;
- group-visible document registrar with the planner.

The default runtime can start with the in-memory queue. A future phase may replace this with Redis without changing the registrar or planner interfaces.

## Idempotency

Idempotency exists at two layers:

- document source registry deduplicates source/evidence;
- document sync queue deduplicates `document-sync:<sourceId>` jobs.

The planner should count enqueued and skipped sources so tests and future observability can explain what happened.

## Constitutional Alignment

This phase keeps the Feishu Gateway ack-first, keeps the event worker lightweight, and advances the whitepaper requirement that group-visible documents move toward body reading and indexing. It does not treat local discovery as authorization; permission checks remain required when document content is fetched and again before model context injection.
