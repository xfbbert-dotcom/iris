# Iris Document Semantic Indexer Embedding Batches Design

## Goal

Prevent a large synced document from sending every chunk to the embedding provider in one oversized
request.

## Architecture

Extend `createDocumentSemanticIndexer` with an optional `embeddingBatchSize` setting. The default is
`64` chunks per embedding request. During indexing, Iris chunks the snapshot as before, then embeds
chunks sequentially in batches while preserving chunk order.

Each batch response must contain exactly one vector per requested chunk. If a provider returns a
short or long batch response, indexing fails before replacing stored fragments. After all batches
return, the existing full-vector validation and fragment replacement flow remains unchanged.

## Invariants

- Existing callers can omit `embeddingBatchSize` and get bounded default behavior.
- Chunk order and fragment replacement semantics do not change.
- Empty, failed, or blank snapshots still skip without calling the embedder.
- Invalid batch size configuration is rejected when constructing the indexer.
- A mismatched batch response fails before `replaceFragmentsForSnapshot`.

## Out Of Scope

- Parallel embedding requests.
- Retry/backoff for provider failures.
- Partial indexing of only the first N chunks.
- Changing the document chunker or document content size bound.
