# Iris Empty Query Embedding Guard Design

## Context

Answer retrieval embeds the user's question before vector search. The context builder already rejects missing embeddings and non-finite embedding values, but it accepted an empty vector. That pushes the failure into the vector repository or database layer, producing a less actionable error and possibly hiding the real provider defect.

## Decision

Reject empty query embeddings inside `DocumentRetrievalContextBuilder` before vector search.

## Scope

- Does not change embedding dimensionality validation for non-empty vectors.
- Does not change provider configuration.
- Does not change fragment retrieval limits or permission filtering.

## Quality Bar

- Empty embedding arrays fail with a clear error.
- Vector search is not called after an empty query embedding.
- Existing missing-embedding and invalid-value guards continue to work.
