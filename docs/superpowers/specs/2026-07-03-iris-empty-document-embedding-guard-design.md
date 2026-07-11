# Iris Empty Document Embedding Guard Design

## Context

Document semantic indexing validates embedding count and finite values before replacing fragments. It did not reject empty vectors, so a provider defect could mark a snapshot as indexed with unusable embeddings or defer the error to a later repository dimension check.

## Decision

Reject empty document embedding vectors in `DocumentSemanticIndexer` before fragment replacement.

## Scope

- Does not change chunking.
- Does not change embedding provider request shape.
- Does not change repository dimension validation.

## Quality Bar

- Empty document embedding vectors fail with a clear error.
- Fragment replacement is not called after empty vectors.
- Existing count mismatch and invalid-value checks continue to work.
