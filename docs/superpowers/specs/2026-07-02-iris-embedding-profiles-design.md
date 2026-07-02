# Iris Embedding Profiles Design

Date: 2026-07-02
Status: Phase 2L approved design
Product name: Iris

## 1. Purpose

Phase 2L makes Iris's document memory safe for real embedding models over time.

Phase 2E stored fragments in a fixed `vector(6)` column for deterministic development tests. Phase 2K added an OpenAI-compatible embedding provider, but the runtime still uses a static 6-dimensional query embedding. If Iris simply switches the runtime to real embeddings, vectors from different dimensions or models can be mixed in the same retrieval path.

Phase 2L introduces embedding profiles: a durable record of which provider, model, and dimension produced a vector. Every indexed fragment and every answer-time query must use the same active profile before vector similarity can be trusted.

## 2. Design Goals

Phase 2L must provide:

- durable `embedding_profiles` metadata;
- profile identity based on provider, model, dimensions, and optional display name;
- explicit profile binding on document fragments;
- a development profile for existing `vector(6)` fragments;
- runtime creation or lookup of the active configured embedding profile;
- answer-time retrieval scoped to the active profile;
- no silent mixing of fragments from different embedding models or dimensions;
- a path for future reindexing without deleting old fragments;
- deterministic tests without real embedding credentials.

The design favors long-term correctness over a one-off fixed dimension migration.

## 3. Out Of Scope

This phase does not implement:

- automatic background reindexing of all existing snapshots;
- profile administration UI;
- multiple active profiles per tenant;
- model quality comparisons;
- cost tracking;
- vector index tuning;
- Feishu live permission API calls;
- real Feishu document body fetching;
- changing the answer API contract.

Those features should build on the profile boundary introduced here.

## 4. Core Concepts

### 4.1 Embedding Profile

An embedding profile represents one embedding configuration.

Required fields:

- `id`;
- `provider`, for Phase 2L only `openai-compatible` and `static-dev`;
- `model`;
- `dimensions`;
- `display_name`;
- `status`, one of `active`, `deprecated`;
- `created_at`.

Uniqueness:

```text
provider + model + dimensions
```

This identity prevents duplicate profiles for the same vector space.

Example profiles:

```text
static-dev / static-dev-6d / 6
openai-compatible / text-embedding-3-small / 1536
openai-compatible / text-embedding-3-large / 3072
```

### 4.2 Static Development Profile

Existing Phase 2E and Phase 2J behavior used 6-dimensional fake vectors.

Phase 2L should preserve that as an explicit profile:

```text
provider: static-dev
model: static-dev-6d
dimensions: 6
display_name: Static development embeddings (6d)
status: active
```

The migration should create this profile and backfill existing fragments with its id. That keeps current local tests and old development data understandable instead of pretending they came from a real model.

### 4.3 Fragment Profile Binding

`document_fragments` must add:

```text
embedding_profile_id
```

Every fragment belongs to exactly one profile. Retrieval must filter by profile id.

The vector column remains concrete. Phase 2L keeps the current `vector(6)` physical column so the codebase can introduce the profile model without forcing a production dimension decision in the same step. Real 1536/3072-dimensional storage requires a later migration that changes the vector column strategy. The profile boundary introduced here is the prerequisite for doing that safely.

### 4.4 Active Runtime Profile

When internal answer drafts are enabled, runtime composition should resolve an active query embedding profile:

- if `IRIS_EMBEDDING_PROVIDER` is configured, read the provider config and find or create the matching profile;
- if no embedding provider is configured, use the static development profile;
- use the active profile id in answer-time fragment retrieval.

In Phase 2L, runtime may still use the static development query embedder when no provider is configured. If a real provider is configured while the physical vector column is still `vector(6)`, runtime must reject configurations whose dimensions are not `6` with an explicit error.

This guard prevents a misleading "wired" runtime that would fail at Postgres vector comparison time.

## 5. Data Model

Add migration:

```text
apps/core/migrations/0004_embedding_profiles.sql
```

It should:

```sql
create table embedding_profiles (
  id text primary key,
  provider text not null check (length(trim(provider)) > 0),
  model text not null check (length(trim(model)) > 0),
  dimensions integer not null check (dimensions > 0),
  display_name text not null check (length(trim(display_name)) > 0),
  status text not null check (status in ('active', 'deprecated')),
  created_at timestamptz not null,
  unique (provider, model, dimensions)
);

insert into embedding_profiles (
  id,
  provider,
  model,
  dimensions,
  display_name,
  status,
  created_at
)
values (
  'static-dev-6d',
  'static-dev',
  'static-dev-6d',
  6,
  'Static development embeddings (6d)',
  'active',
  now()
)
on conflict (provider, model, dimensions) do nothing;

alter table document_fragments
  add column embedding_profile_id text;

update document_fragments
set embedding_profile_id = 'static-dev-6d'
where embedding_profile_id is null;

alter table document_fragments
  alter column embedding_profile_id set not null;

alter table document_fragments
  add constraint document_fragments_embedding_profile_id_fkey
  foreign key (embedding_profile_id)
  references embedding_profiles(id);
```

Add an index:

```sql
create index document_fragments_profile_chunk_idx
on document_fragments (embedding_profile_id, document_source_id, chunk_index asc, id asc);
```

Vector search should use `where embedding_profile_id = $profileId`.

## 6. Repository Boundaries

Add an `EmbeddingProfileRepository`.

Required methods:

```ts
type EmbeddingProfile = {
  id: string;
  provider: "static-dev" | "openai-compatible";
  model: string;
  dimensions: number;
  displayName: string;
  status: "active" | "deprecated";
  createdAt: Date;
};

type FindOrCreateEmbeddingProfileInput = {
  provider: EmbeddingProfile["provider"];
  model: string;
  dimensions: number;
  displayName: string;
};
```

The repository should provide:

- `findOrCreateProfile(input)`;
- `getStaticDevelopmentProfile()`.

`DocumentFragmentRepository.replaceFragmentsForSnapshot` should require `embeddingProfileId`. `searchSimilarFragments` should require `embeddingProfileId`.

This makes profile scoping impossible to forget in callers and tests.

## 7. Runtime Wiring

Answer draft runtime should add dependencies:

- `createEmbeddingProfileRepository`;
- `createEmbeddingProvider`.

Runtime flow:

```text
read answer draft runtime config
-> read model config
-> read embedding provider config
-> create Postgres pool
-> create fragment repository
-> create embedding profile repository
-> resolve active embedding profile
-> create query embedder
-> create context builder scoped to active embedding profile
-> create answer draft orchestrator
```

If no embedding provider config exists:

```text
active profile = static development profile
query embedder = static 6d embedder
```

If an embedding provider config exists:

```text
active profile = find or create openai-compatible profile
query embedder = OpenAI-compatible embedding provider
```

For Phase 2L, if configured dimensions are not `6`, runtime must throw:

```text
IRIS_EMBEDDING_DIMENSIONS must be 6 until document_fragments vector storage is migrated
```

If dimensions are omitted for a configured provider, runtime must throw:

```text
IRIS_EMBEDDING_DIMENSIONS is required when internal answer drafts use an embedding provider
```

These guards keep Phase 2L honest: profiles are wired, but production-sized vector storage remains a later phase.

## 8. Indexing Flow

`DocumentSemanticIndexer` should receive an `embeddingProfileId` when indexing a snapshot.

Indexing flow:

```text
snapshot fetch_status = succeeded
-> chunk body text
-> embed chunk texts
-> validate embedding count and vector values
-> replace fragments for snapshot with embedding_profile_id
```

The indexer should not decide which profile is active. A future sync worker or indexing job should resolve the profile before calling it. This keeps indexing deterministic and avoids hidden global state.

## 9. Retrieval Flow

Answer-time document retrieval must use the active profile:

```text
question text
-> embed query with active profile's provider
-> search fragments where embedding_profile_id = active_profile.id
-> permission guard
-> context anchor prompt assembly
```

This prevents a query vector from one model from ranking fragments produced by another model.

## 10. Error Handling

Phase 2L should fail explicitly when:

- runtime is enabled and model config is missing;
- runtime is configured with an embedding provider but `IRIS_EMBEDDING_DIMENSIONS` is missing;
- runtime is configured with a non-6 embedding dimension before vector storage migration;
- fragment replacement is called without a profile id;
- fragment search is called without a profile id;
- profile repository cannot create or read the required profile.

It should not silently fall back from a configured real provider to static development embeddings.

## 11. Testing Strategy

Unit tests should cover:

- migration runner sees `0004_embedding_profiles.sql`;
- embedding profile repository creates the static development profile;
- repository `findOrCreateProfile` returns existing profile on conflict;
- fragment replacement writes `embedding_profile_id`;
- fragment search SQL filters by `embedding_profile_id`;
- semantic indexer passes `embeddingProfileId` to fragment replacement;
- runtime uses static development profile when no embedding provider is configured;
- runtime creates an OpenAI-compatible embedding profile when provider config exists and dimensions are `6`;
- runtime rejects missing provider dimensions;
- runtime rejects non-6 provider dimensions until vector storage migration exists.

Final verification must include:

- `npm run typecheck`;
- `npm test`;
- `python -m pytest` from `workers/ai`;
- `docker compose config`.

## 12. Future Integration Points

Phase 2M can add a real vector storage migration:

- move from `vector(6)` to a production dimension;
- or split vectors into profile-specific physical tables;
- or add a generated vector column per supported dimension.

Phase 2N can add reindexing:

- list snapshots eligible for a target profile;
- enqueue indexing jobs;
- mark profile coverage per source or snapshot;
- expose admin controls for profile rollout.

Recommended next phase after 2L:

> Choose the physical vector storage strategy for production-sized embeddings, then add a reindexing job that fills fragments for the selected profile without mixing old and new vector spaces.
