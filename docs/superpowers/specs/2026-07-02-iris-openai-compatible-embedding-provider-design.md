# Iris OpenAI-Compatible Embedding Provider Design

Date: 2026-07-02
Status: Phase 2K approved design
Product name: Iris

## 1. Purpose

Phase 2K adds Iris's first real embedding provider adapter.

Phase 2J still uses a static 6-dimensional query embedding to keep the answer draft runtime executable in development mode. Phase 2K introduces an OpenAI-compatible `/embeddings` adapter behind Iris's existing `EmbeddingProvider` interface so query and document embedding can later use real semantic vectors.

This phase does not migrate `document_fragments.embedding vector(6)` and does not reindex documents. It creates the provider boundary and configuration needed for a future dimension migration.

## 2. Design Goals

Phase 2K must provide:

- OpenAI-compatible `/embeddings` provider;
- environment-driven embedding provider configuration;
- optional configured dimensions;
- deterministic tests with fake `fetch`;
- explicit errors for missing config, HTTP failures, malformed responses, count mismatches, invalid vectors, and timeout;
- no changes to `document_fragments` schema;
- no automatic runtime replacement of the static query embedder yet.

The adapter should be generic enough for OpenAI-compatible embedding APIs from hosted or local providers.

## 3. Out Of Scope

This phase does not implement:

- pgvector dimension migration;
- document reindexing;
- runtime replacement of `createStaticQueryEmbeddingProvider`;
- provider-specific SDKs;
- batching policy beyond sending the input array;
- retries and backoff;
- cost tracking;
- Feishu live permission checks.

Those features belong in later phases.

## 4. Configuration

Add embedding provider config readers in `apps/core/src/config/env.ts`.

Environment variables:

- `IRIS_EMBEDDING_PROVIDER`: provider kind. Phase 2K supports `openai-compatible`.
- `IRIS_EMBEDDING_BASE_URL`: base URL, for example `https://api.openai.com/v1`.
- `IRIS_EMBEDDING_API_KEY`: bearer token.
- `IRIS_EMBEDDING_MODEL`: embedding model name.
- `IRIS_EMBEDDING_DIMENSIONS`: optional positive integer dimensions parameter.
- `IRIS_EMBEDDING_TIMEOUT_MS`: optional request timeout. Default: `30000`.

Blank strings should be treated as missing values.

The config reader should return undefined when `IRIS_EMBEDDING_PROVIDER` is missing. If `IRIS_EMBEDDING_PROVIDER=openai-compatible`, base URL, API key, and model name are required.

## 5. Provider Contract

The adapter implements the existing Phase 2E interface:

```ts
export interface EmbeddingProvider {
  embedTexts(texts: string[]): Promise<number[][]>;
}
```

The adapter should call:

```text
POST <baseUrl>/embeddings
Authorization: Bearer <apiKey>
Content-Type: application/json
```

Body:

```json
{
  "model": "<model>",
  "input": ["text-a", "text-b"],
  "dimensions": 1536
}
```

`dimensions` should be omitted when not configured.

## 6. Response Handling

The adapter should parse:

```text
data[].embedding
```

It must:

- return vectors in the same order as input text;
- require one embedding per input text;
- require each embedding to be an array of finite numbers;
- return `[]` immediately for empty input without calling `fetch`;
- throw on non-2xx responses;
- throw on invalid JSON;
- throw on malformed embedding data;
- throw on timeout.

## 7. Testing Strategy

Unit tests should cover:

- config reader returns undefined when provider is missing;
- config reader trims values and parses dimensions and timeout;
- config reader rejects incomplete config;
- config reader rejects invalid dimensions and timeout;
- provider sends expected URL, headers, body, and optional dimensions;
- provider returns embeddings in order;
- provider does not call fetch for empty input;
- provider throws on count mismatch;
- provider throws on invalid vector values;
- provider throws on non-2xx status;
- provider throws on timeout.

Final verification must include:

- `npm run typecheck`;
- `npm test`;
- `python -m pytest` from `workers/ai`;
- `docker compose config`.

## 8. Future Integration Points

Phase 2L can add:

- embedding dimension migration for `document_fragments`;
- document fragment reindexing job;
- runtime replacement of static query embedding with configured embedding provider;
- embedding provider observability.

Recommended next phase after 2K:

> Add a planned pgvector dimension migration and reindexing strategy before switching runtime retrieval from static development embeddings to real embeddings.
