CREATE TABLE document_snapshot_reindex_completions (
  id TEXT PRIMARY KEY CHECK (char_length(id) BETWEEN 1 AND 512),
  document_snapshot_id TEXT NOT NULL REFERENCES document_snapshots(id) ON DELETE RESTRICT,
  embedding_profile_id TEXT NOT NULL REFERENCES embedding_profiles(id) ON DELETE RESTRICT,
  completion_kind TEXT NOT NULL CHECK (completion_kind IN ('indexed', 'already_indexed')),
  fragment_count INTEGER NOT NULL CHECK (fragment_count >= 0),
  completed_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (document_snapshot_id, embedding_profile_id)
);

CREATE TRIGGER document_snapshot_reindex_completions_append_only
BEFORE UPDATE OR DELETE ON document_snapshot_reindex_completions
FOR EACH ROW EXECUTE FUNCTION knowledge_draft_append_only_guard();

CREATE TRIGGER document_snapshot_reindex_completions_truncate_guard
BEFORE TRUNCATE ON document_snapshot_reindex_completions
FOR EACH STATEMENT EXECUTE FUNCTION knowledge_draft_append_only_guard();

ALTER TABLE managed_knowledge_pages
  ADD COLUMN current_reconciled_snapshot_id TEXT
    REFERENCES document_snapshots(id) ON DELETE RESTRICT;

CREATE INDEX managed_knowledge_pages_current_reconciled_snapshot_idx
  ON managed_knowledge_pages (current_reconciled_snapshot_id)
  WHERE current_reconciled_snapshot_id IS NOT NULL;
