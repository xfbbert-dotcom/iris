# Iris Document Fragment Freshness Design

## Context

Iris keeps document snapshots over time so admins can inspect sync history and failed fetches. Semantic retrieval previously searched all indexed fragments for the active embedding profile. That allowed fragments from older successful snapshots to appear in answer context after a document had already synced a newer version.

The profile-aware vector storage work also introduced a second durability requirement: the same snapshot must be indexable by more than one embedding profile during model migration or reindexing. The old document fragment uniqueness constraint still allowed only one fragment per `(document_snapshot_id, chunk_index)`.

## Decision

Vector retrieval now joins the latest successful snapshot per document source before ranking fragments. The query still ranks by vector distance, then applies stable tie-breakers by source id, chunk index, and fragment id.

The database schema now includes a migration that replaces the old fragment uniqueness constraint with `(document_snapshot_id, embedding_profile_id, chunk_index)`. This lets static development embeddings and production embeddings coexist for the same snapshot without conflict.

Manual profile reindex planning now selects only the latest successful snapshot per document source before checking whether that snapshot is missing the target embedding profile. This keeps reindex cost aligned with retrieval behavior and avoids embedding historical versions that cannot be used in answer drafts.

## Scope

- Does not delete historical fragments or snapshots.
- Does not change live permission checks; source-policy and runtime guards still run after retrieval.
- Does not change the embedding provider contract.
- Does not change failed-snapshot handling; retrieval uses the newest successful snapshot available for each source.
- Does not change document-synced reindex jobs; a newly synced snapshot is still enqueued directly.

## Quality Bar

- Updated documents do not leak older indexed content into answer drafts.
- Retrieval order remains deterministic when distances tie.
- Reindexing the same snapshot for a new embedding profile is supported by schema constraints.
- Manual profile reindexing does not enqueue obsolete historical snapshots.
