# Iris Embedding Provider Batch Budget Design

## Goal

Prevent direct embedding provider callers from sending oversized text batches to an external
OpenAI-compatible embeddings API.

## Architecture

`DocumentSemanticIndexer` already embeds document chunks in batches of `64` by default. The
OpenAI-compatible embedding provider now enforces the same maximum at its own boundary before
constructing the HTTP request body.

This keeps the provider safe for future direct callers such as maintenance scripts, reindex tools,
or tests that bypass the semantic indexer batching layer.

## Invariants

- Empty embedding requests still return an empty vector array without fetch.
- Valid batches of `64` or fewer texts are unchanged.
- Oversized batches are rejected before fetch, timeout setup, or response parsing.
- Response count, index, vector value, and dimension validation remain unchanged.

## Out Of Scope

- Changing the default semantic indexer batch size.
- Automatically splitting oversized provider batches.
- Adding provider-specific token counting.
- Changing retry or backoff behavior for embedding requests.
