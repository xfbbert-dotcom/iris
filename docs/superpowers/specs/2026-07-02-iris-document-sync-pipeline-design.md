# Iris Document Sync Pipeline Design

Date: 2026-07-02
Status: Phase 2D approved design
Product name: Iris

## 1. Purpose

Phase 2D introduces Iris's document sync pipeline skeleton.

Phase 2B created a domain registry for document sources. Phase 2C moved that registry into Postgres and made document-source facts durable. Phase 2D makes the next step explicit: Iris can select pending document sources, attempt to fetch their body through a replaceable fetcher interface, persist a document snapshot, and update sync state.

This phase does not connect to real Feishu document APIs. It creates the state machine, persistence shape, and execution boundary that the real Feishu document fetcher will plug into later.

Constitutional alignment:

> Iris reads both chat text and readable document bodies. Every document entering memory must preserve source, permission, version, and visibility scope.

## 2. Design Goals

Phase 2D must provide:

- a durable document snapshot table linked to `document_sources`;
- a typed `DocumentBodyFetcher` interface;
- a sync planner that selects sources eligible for syncing;
- a sync runner that processes one source at a time;
- explicit sync-state transitions: `pending -> syncing -> synced | failed`;
- deterministic behavior that can be tested without Feishu credentials;
- failure recording that preserves the reason a sync failed;
- a narrow boundary for later Feishu document fetching.

The pipeline should make it hard to accidentally skip source-state updates. If Iris attempts a sync, the fact layer should show what happened.

## 3. Out Of Scope

This phase does not implement:

- real Feishu document body fetching;
- Feishu wiki traversal;
- OAuth installation or token refresh;
- parsing `.docx`, wiki block trees, PDFs, or uploaded files;
- chunking, embeddings, or pgvector tables;
- real-time Feishu permission guard calls;
- retry scheduler or background worker loop;
- admin UI screens.

Those features should attach to the pipeline through the fetcher and snapshot boundaries.

## 4. Core Concepts

### 4.1 Document Source

`document_sources` remains the canonical source registry.

The sync pipeline reads sources from the registry and updates their `sync_state`.

Eligible sources for Phase 2D are:

- `sync_state = 'pending'`;
- `can_use_for_answering = true` or `can_use_for_knowledge_drafts = true`;
- `permission_state != 'denied'`.

Phase 2D may also support explicit syncing by source id, even if a planner would not automatically select that source. The runner must still reject denied sources.

### 4.2 Document Snapshot

A document snapshot is the persisted result of one successful or failed fetch attempt.

The first snapshot schema should be simple and factual:

- `id text primary key`
- `document_source_id text not null references document_sources(id) on delete cascade`
- `source_uri text not null`
- `fetch_status text not null`
- `body_text text null`
- `content_hash text null`
- `source_version text null`
- `fetched_at timestamptz not null`
- `error_message text null`
- `created_at timestamptz not null`

`fetch_status` values:

- `succeeded`
- `failed`

`body_text` is acceptable in Phase 2D because the goal is to validate the fetch boundary and state machine. Future phases may move large bodies to object storage or a dedicated document body table if document sizes justify it.

### 4.3 DocumentBodyFetcher

The fetcher is the only dependency that knows how to read a source body.

```ts
export type DocumentBodyFetchResult = {
  bodyText: string;
  sourceVersion?: string;
  fetchedAt: Date;
};

export interface DocumentBodyFetcher {
  fetch(source: DocumentSource): Promise<DocumentBodyFetchResult>;
}
```

Phase 2D tests should use fake fetchers. Phase 2E can implement a Feishu-backed fetcher without changing the sync runner contract.

## 5. Sync State Machine

### 5.1 Success Path

```text
source sync_state = pending
-> runner marks source syncing
-> fetcher.fetch(source)
-> runner stores document snapshot with fetch_status = succeeded
-> runner marks source synced
-> runner returns success result
```

### 5.2 Failure Path

```text
source sync_state = pending
-> runner marks source syncing
-> fetcher.fetch(source) fails
-> runner stores document snapshot with fetch_status = failed and error_message
-> runner marks source failed
-> runner returns failure result or rethrows according to caller policy
```

For Phase 2D, the runner should return a structured failure result instead of throwing after it has recorded the failure. Unexpected database failures may still throw.

### 5.3 Rejected Path

If a source is not eligible because permission is `denied`, the runner should not call the fetcher. It should leave the source state unchanged and return a rejected result with a clear reason.

## 6. Planner Behavior

The planner should be narrow:

- list candidate sources from the registry;
- filter to sources with `syncState = 'pending'`;
- exclude `permissionState = 'denied'`;
- exclude sources where both `canUseForAnswering` and `canUseForKnowledgeDrafts` are false;
- return deterministic order using registry ordering.

The planner does not fetch bodies and does not mutate state.

## 7. Persistence Behavior

Phase 2D should add a second migration:

```text
apps/core/migrations/0002_document_snapshots.sql
```

The migration creates `document_snapshots` and indexes:

- `document_snapshots_document_source_id_idx`
- `document_snapshots_fetched_at_idx`

The sync runner should use repository functions to:

- insert a succeeded snapshot;
- insert a failed snapshot;
- list snapshots for a source;
- find the latest snapshot for a source.

Snapshots are append-only in Phase 2D. Updating a source creates a new snapshot rather than editing the old one.

## 8. Idempotency And Concurrency

Phase 2D should keep idempotency conservative.

The runner should check the latest source state before syncing. If the source is already `syncing`, it should return a skipped result rather than starting another fetch.

If the source is already `synced`, Phase 2D should skip automatic syncing. Explicit force-resync is out of scope.

This is not a complete distributed lock. It is enough for the current modular monolith and tests. If sync jobs later run in parallel workers, Iris should add row-level claim semantics with `select ... for update skip locked` or an equivalent job-claim table.

## 9. Error Handling

Fetcher failures should be converted to failed snapshots with a concise error message.

The runner should distinguish:

- `synced`: body fetched and snapshot stored;
- `failed`: fetcher failed, failure snapshot stored, source marked failed;
- `skipped`: source was already syncing/synced or not eligible;
- `rejected`: permission or capability state forbids sync.

The runner must not claim a source is synced unless snapshot insert succeeded.

## 10. Testing Strategy

Unit tests should cover:

- planner selects pending eligible sources;
- planner excludes denied sources;
- planner excludes sources disabled for both answer and knowledge draft use;
- runner marks a source syncing before fetching;
- runner stores a successful snapshot and marks source synced;
- runner stores a failed snapshot and marks source failed;
- runner does not call fetcher for denied sources;
- runner skips already syncing or synced sources;
- snapshot repository can list and retrieve latest snapshot deterministically.

Postgres integration tests should be optional and gated by `DATABASE_URL`, consistent with Phase 2C. Non-database tests should still cover the state machine with fakes so CI without Docker remains meaningful.

## 11. Future Integration Points

Phase 2E can add:

- Feishu document body fetcher;
- Feishu wiki fetcher;
- user-upload fetcher;
- permission-aware fetch preflight;
- retry and backoff policy;
- Python parsing/chunking job dispatch after successful snapshots;
- pgvector indexing of chunks.

Constitutional principle:

> Phase 2D does not teach Iris how to read Feishu yet. It teaches Iris how to responsibly attempt a document sync, preserve what happened, and leave a clean seam for real document readers.
