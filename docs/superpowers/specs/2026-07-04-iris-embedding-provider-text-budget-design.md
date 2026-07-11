# Iris Embedding Provider Text Budget Design

## Goal

Prevent direct embedding provider callers from sending oversized individual text inputs to the
external embeddings API.

## Architecture

The document chunker produces document chunks of `1200` characters by default, and answer-time
retrieval query text is limited to `4000` characters. The OpenAI-compatible embedding provider now
enforces a provider-level `4000` character maximum for every text item before constructing the HTTP
request body.

This preserves the normal indexing and retrieval paths while preventing future direct callers from
bypassing upstream chunking and query budgets.

## Invariants

- Empty embedding requests still return an empty vector array without fetch.
- Batches of `64` or fewer texts remain governed by the provider batch budget.
- Text inputs at or below `4000` characters are unchanged.
- Oversized text inputs are rejected before fetch, timeout setup, or response parsing.

## Out Of Scope

- Changing document chunker sizes.
- Changing the retrieval query budget.
- Token-aware embedding input splitting.
- Automatically truncating oversized embedding text.
