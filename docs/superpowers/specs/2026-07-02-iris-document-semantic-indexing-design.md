# Iris Document Semantic Indexing Design

Date: 2026-07-02
Status: Phase 2E approved design
Product name: Iris

## 1. Purpose

Phase 2E turns successfully synced document snapshots into retrievable document fragments.

Phase 2D gave Iris a responsible document sync state machine: select a source, fetch body text through a replaceable fetcher, persist a snapshot, and record success or failure. Phase 2E adds the next layer: split successful snapshot text into ordered fragments, generate embeddings through a replaceable provider, store those fragments durably, and expose a narrow retrieval interface for later answer assembly.

This phase does not make Iris answer document questions end to end. It gives Iris the semantic indexing substrate that future orchestration can use safely.

Constitutional alignment:

> Iris reads both chat text and readable document bodies. Every document entering memory must preserve source, permission, version, and visibility scope.
> Retrieval must re-check live permissions before document content reaches the model.

## 2. Design Goals

Phase 2E must provide:

- a durable `document_fragments` table linked to both `document_sources` and `document_snapshots`;
- a deterministic `DocumentChunker` for plain text snapshots;
- an `EmbeddingProvider` interface that can be backed by tests, OpenAI, local models, or other providers later;
- a `DocumentFragmentRepository` for replacing and reading indexed fragments;
- a `DocumentSemanticIndexer` that indexes one successful snapshot at a time;
- deterministic tests without real embedding credentials;
- source and snapshot metadata preserved on every fragment;
- retrieval results that still require the real-time permission guard before use in model context.

The phase should make it easy to plug in real embeddings later without changing the indexing state machine.

## 3. Out Of Scope

This phase does not implement:

- real Feishu document body fetching;
- PDF, `.docx`, wiki block tree, or file parsing;
- real OpenAI or vendor embedding calls;
- complete answer generation;
- prompt assembly with `<background_documents>` and `<live_chat_context>`;
- live Feishu permission API calls;
- chunk-level citations in final responses;
- background job scheduling;
- reindex scheduling after document updates;
- admin UI screens.

Those features should attach to this phase through the repository, embedding provider, and retrieval boundaries.

## 4. Core Concepts

### 4.1 Document Snapshot

Only successful snapshots are eligible for semantic indexing.

A snapshot is indexable when:

- `fetchStatus = "succeeded"`;
- `bodyText` is present;
- `bodyText.trim()` is not empty.

Failed snapshots are facts about sync attempts, but they do not produce fragments.

### 4.2 Document Fragment

A document fragment is an ordered chunk of text derived from exactly one snapshot.

Each fragment must preserve:

- fragment id;
- document source id;
- document snapshot id;
- source URI;
- chunk index;
- text;
- content hash;
- embedding vector;
- created timestamp.

The source id is the permission boundary. Retrieval may rank by semantic similarity, but the final context-injection path must run the existing permission guard using document/source ids before passing fragment text to the model.

### 4.3 DocumentChunker

The first chunker should be deterministic and plain-text-only.

Rules:

- normalize line endings to `\n`;
- trim leading and trailing whitespace;
- split on blank lines into paragraph-like blocks;
- merge small adjacent blocks until a configurable `maxChunkChars` limit would be exceeded;
- hard-split any single block longer than `maxChunkChars`;
- discard empty chunks;
- preserve order with `chunkIndex`.

Default limits:

- `maxChunkChars = 1200`;
- `minChunkChars = 80` for merging small adjacent blocks where possible.

The goal is not perfect semantic segmentation. The goal is a stable, testable baseline that keeps later parser improvements isolated.

### 4.4 EmbeddingProvider

The embedding provider owns vector generation.

```ts
export interface EmbeddingProvider {
  embedTexts(texts: string[]): Promise<number[][]>;
}
```

Rules:

- input order must match output order;
- the provider must return one vector per input text;
- empty text should never be sent to the provider;
- if vector count does not match text count, indexing must fail;
- vectors must be finite numbers.

Tests use deterministic fake embeddings. Real embedding providers are out of scope for Phase 2E.

### 4.5 DocumentFragmentRepository

The repository owns fragment persistence.

Required behavior:

- replace all fragments for a snapshot in one operation;
- list fragments for a source in stable order;
- list fragments for a snapshot in stable order;
- search fragments with a query vector and limit.

For Phase 2E, vector search can use Postgres with `pgvector` when available. Unit tests can validate SQL shape through fake queryables without requiring a running database. If local Postgres integration is available, tests should remain gated by `DATABASE_URL`.

### 4.6 DocumentSemanticIndexer

The semantic indexer coordinates chunking, embedding, and persistence.

Indexing flow:

```text
snapshot fetch_status = succeeded
-> validate snapshot has non-empty body text
-> chunk body text
-> embed chunk texts
-> validate embedding count and vector values
-> replace fragments for snapshot
-> return indexed count
```

Skipped flow:

```text
snapshot failed or empty
-> do not call embedding provider
-> do not write fragments
-> return skipped result with reason
```

## 5. Database Shape

Phase 2E adds:

```text
apps/core/migrations/0003_document_fragments.sql
```

The migration should enable `vector` if available and create:

```sql
create extension if not exists vector;

create table document_fragments (
  id text primary key,
  document_source_id text not null references document_sources(id) on delete cascade,
  document_snapshot_id text not null references document_snapshots(id) on delete cascade,
  source_uri text not null,
  chunk_index integer not null check (chunk_index >= 0),
  text text not null check (length(trim(text)) > 0),
  content_hash text not null,
  embedding vector(6) not null,
  created_at timestamptz not null,
  unique (document_snapshot_id, chunk_index)
);
```

Phase 2E uses `vector(6)` intentionally. It is small enough for deterministic tests and keeps the schema concrete. A future real embedding phase may add a migration to move to the production embedding dimension, for example 1536 or 3072, once the provider is chosen.

Indexes:

- `(document_source_id, chunk_index asc, id asc)`;
- `(document_snapshot_id, chunk_index asc, id asc)`;
- vector index may be deferred until production embedding dimensions are chosen.

## 6. Retrieval Contract

Phase 2E retrieval returns candidate fragments, not authorized answer context.

`DocumentFragmentRepository.searchSimilarFragments` should return:

- fragment id;
- document source id;
- snapshot id;
- source URI;
- chunk index;
- text;
- similarity or distance score when available.

The answer path must later run:

```text
semantic retrieval
-> real-time permission guard
-> context anchor prompt assembly
-> model response
```

This phase only implements the first step.

## 7. Error Handling

Indexer failures should be explicit.

The indexer must throw when:

- embedding provider returns the wrong number of vectors;
- any vector contains `NaN`, `Infinity`, or a non-number;
- repository replace fails.

The indexer should return a skipped result when:

- snapshot fetch status is `failed`;
- snapshot has no body text;
- snapshot body text is blank after trimming.

It should not silently create placeholder fragments.

## 8. Testing Strategy

Unit tests should cover:

- chunker splits paragraph text deterministically;
- chunker hard-splits long blocks;
- chunker discards blank input;
- indexer skips failed snapshots;
- indexer skips blank successful snapshots;
- indexer embeds chunks and replaces fragments;
- indexer rejects mismatched embedding counts;
- indexer rejects invalid vectors;
- repository writes replacement fragments in deterministic order;
- repository search SQL preserves limit and vector parameter shape.

Optional Postgres integration tests should be gated by `DATABASE_URL`. Without `DATABASE_URL`, all normal unit tests must still pass.

Final verification must include:

- `npm run typecheck`;
- `npm test`;
- `python -m pytest` from `workers/ai`;
- `docker compose config`.

## 9. Future Integration Points

Phase 2F can add one of:

- real embedding provider configuration;
- context assembly that combines semantic document retrieval with the existing permission guard;
- background job dispatch after document sync success;
- Feishu document body fetcher;
- production vector dimensions and vector indexes.

Recommended next phase after 2E:

> Add answer-time document retrieval with real-time permission guard and context anchoring, so Iris can use indexed document fragments without diluting live group chat context.
