# Iris Dimension-Sharded Vector Storage Design

Date: 2026-07-02
Status: Phase 2M approved design
Product name: Iris

## 1. Purpose

Phase 2M lets Iris store and retrieve real production-sized embeddings without forcing all profiles into one physical vector dimension.

Phase 2L introduced `embedding_profiles`, but `document_fragments` still stores vectors directly in `embedding vector(6)`. That keeps development behavior working, but it blocks real embedding profiles such as 1536-dimensional OpenAI-compatible embeddings. Phase 2M moves vectors out of `document_fragments` and into dimension-specific embedding tables.

The chosen architecture is dimension-sharded vector storage.

## 2. Design Goals

Phase 2M must provide:

- fragment metadata separated from vector storage;
- one physical pgvector table per supported dimension;
- first-class support for 6-dimensional development vectors and 1536-dimensional production vectors;
- repository routing by `embeddingProfileId` and profile dimensions;
- explicit errors for unsupported dimensions;
- no mixing of vector spaces during search;
- a clear path to add 3072-dimensional tables later;
- deterministic tests without real embedding credentials.

The goal is to make real `IRIS_EMBEDDING_DIMENSIONS=1536` usable in answer-time retrieval while preserving the static development path.

## 3. Out Of Scope

This phase does not implement:

- 3072-dimensional storage;
- automatic reindexing of existing document snapshots into the 1536-dimensional table;
- vector index tuning such as HNSW or IVFFlat;
- profile rollout administration;
- cost tracking;
- multi-tenant profile policies;
- Feishu live permission API calls;
- real Feishu document body fetching.

Those features should build on this physical storage boundary.

## 4. Architecture

### 4.1 Fragment Metadata Table

`document_fragments` should become the canonical table for text and provenance metadata:

- `id`;
- `document_source_id`;
- `document_snapshot_id`;
- `source_uri`;
- `chunk_index`;
- `text`;
- `content_hash`;
- `embedding_profile_id`;
- `created_at`.

It should no longer be the source of truth for the vector column.

For compatibility during migration, Phase 2M may leave the old `document_fragments.embedding vector(6)` column in place but stop writing and searching from it. A later cleanup migration can drop it after the dimension-sharded path has been stable.

### 4.2 Dimension-Specific Embedding Tables

Add:

```text
document_fragment_embeddings_6
document_fragment_embeddings_1536
```

Each table stores:

- `document_fragment_id`;
- `embedding_profile_id`;
- `embedding`;
- `created_at`.

Physical shapes:

```sql
create table document_fragment_embeddings_6 (
  document_fragment_id text primary key references document_fragments(id) on delete cascade,
  embedding_profile_id text not null references embedding_profiles(id),
  embedding vector(6) not null,
  created_at timestamptz not null
);

create table document_fragment_embeddings_1536 (
  document_fragment_id text primary key references document_fragments(id) on delete cascade,
  embedding_profile_id text not null references embedding_profiles(id),
  embedding vector(1536) not null,
  created_at timestamptz not null
);
```

Both tables should index `embedding_profile_id`.

Vector indexes may be deferred until production traffic needs them. Correct profile routing is more important than premature index tuning.

### 4.3 Static Development Backfill

Existing `document_fragments.embedding vector(6)` data should be copied into `document_fragment_embeddings_6`.

Migration flow:

```text
create dimension-specific tables
-> insert existing fragment vectors into document_fragment_embeddings_6
-> keep old document_fragments.embedding column for compatibility
-> update repository to stop using document_fragments.embedding
```

This avoids destructive data loss and keeps old development fragments searchable through the new routing layer.

## 5. Repository Routing

`DocumentFragmentRepository` should no longer assume vectors live on `document_fragments`.

It should resolve the target embedding table from a supported dimension:

```ts
type SupportedEmbeddingDimension = 6 | 1536;
```

The repository should receive an `EmbeddingProfileLookup` dependency:

```ts
type EmbeddingProfileLookup = {
  getProfileById(id: string): Promise<{ id: string; dimensions: number }>;
};
```

Write path:

```text
replaceFragmentsForSnapshot(input)
-> get profile by input.embeddingProfileId
-> resolve embedding table from profile.dimensions
-> delete existing fragments for snapshot
-> insert fragment metadata rows
-> insert vectors into the dimension-specific embedding table
```

Search path:

```text
searchSimilarFragments(input)
-> get profile by input.embeddingProfileId
-> resolve embedding table from profile.dimensions
-> query document_fragments join document_fragment_embeddings_<dimension>
-> filter both fragment and embedding rows by embedding_profile_id
-> order by embedding distance
```

If the profile dimension is unsupported, throw:

```text
Unsupported embedding dimension: 3072
```

The implementation should replace `3072` with the actual unsupported dimension.

### 5.1 SQL Shape

For 6-dimensional search:

```sql
select
  f.*,
  e.embedding,
  e.embedding <=> $2::vector as distance
from document_fragments f
join document_fragment_embeddings_6 e
  on e.document_fragment_id = f.id
where f.embedding_profile_id = $1
  and e.embedding_profile_id = $1
order by e.embedding <=> $2::vector asc
limit $3;
```

For 1536-dimensional search, the same query uses `document_fragment_embeddings_1536`.

Table names must not come from raw user input. They must be selected from a closed mapping:

```ts
const embeddingTables = {
  6: "document_fragment_embeddings_6",
  1536: "document_fragment_embeddings_1536",
} as const;
```

## 6. Embedding Profile Repository Changes

Add:

```ts
getProfileById(id: string): Promise<EmbeddingProfile>;
```

`DocumentFragmentRepository` should depend on that method instead of receiving dimensions directly from callers. Callers should pass profile ids; repositories should own profile-to-table routing.

This keeps runtime, indexer, and retrieval context simple:

```text
they know which profile is active, but not which table stores that profile's vectors
```

## 7. Runtime Changes

Phase 2L rejected real providers unless `IRIS_EMBEDDING_DIMENSIONS=6`.

Phase 2M should allow:

```text
IRIS_EMBEDDING_DIMENSIONS=6
IRIS_EMBEDDING_DIMENSIONS=1536
```

Runtime should still reject unsupported dimensions, for example 3072, until a matching physical table exists:

```text
Unsupported embedding dimension: 3072
```

The active profile still gates retrieval. A 1536-dimensional query only searches `document_fragment_embeddings_1536` rows for that exact profile.

## 8. Indexing Flow

The semantic indexer still receives:

```text
embeddingProfileId
```

It does not need to know the physical table. It passes chunks and vectors to the fragment repository. The repository validates profile dimension support and writes vectors to the right dimension table.

This keeps indexing policy separate from storage routing.

## 9. Retrieval Flow

Answer-time retrieval remains:

```text
question text
-> embed query with active profile's provider
-> fragment repository resolves profile dimension
-> search matching dimension-specific embedding table
-> permission guard
-> context anchor prompt assembly
```

This preserves the Phase 2L guarantee:

> A query vector can only rank fragments produced by the same embedding profile.

## 10. Error Handling

Phase 2M should fail explicitly when:

- profile id is unknown;
- profile dimension is unsupported;
- vector count does not match chunk count;
- vector length does not match the profile dimension;
- dimension-specific insert fails;
- dimension-specific search table is unavailable.

It should not silently fall back to another profile, another dimension table, or JSON/array scanning.

## 11. Testing Strategy

Unit tests should cover:

- migration runner sees `0005_dimension_sharded_vector_storage.sql`;
- migration contains `document_fragment_embeddings_6` and `document_fragment_embeddings_1536`;
- profile repository reads profile by id;
- fragment replacement routes 6-dimensional vectors to `document_fragment_embeddings_6`;
- fragment replacement routes 1536-dimensional vectors to `document_fragment_embeddings_1536`;
- search routes by profile dimension;
- unsupported dimension throws `Unsupported embedding dimension`;
- vector length mismatch throws an explicit error;
- runtime accepts `IRIS_EMBEDDING_DIMENSIONS=1536`;
- runtime rejects unsupported dimensions such as `3072`.

Final verification must include:

- `npm run typecheck`;
- `npm test`;
- `python -m pytest` from `workers/ai`;
- `docker compose config`.

## 12. Future Integration Points

Phase 2N can add reindexing:

- choose a target profile;
- find successful document snapshots with no embeddings for that profile;
- enqueue indexing jobs;
- track coverage per snapshot and profile.

Phase 2O can add vector indexes:

- HNSW or IVFFlat per dimension table;
- index build controls;
- performance metrics per profile.

Phase 2P can add 3072-dimensional storage:

- create `document_fragment_embeddings_3072`;
- extend the closed routing map;
- add tests for 3072 writes and search.

Recommended next phase after 2M:

> Add a reindexing job that fills `document_fragment_embeddings_1536` for existing readable snapshots, so Iris can answer using real production embeddings instead of only querying empty 1536-dimensional storage.
