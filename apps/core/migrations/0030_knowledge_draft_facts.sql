CREATE TABLE knowledge_drafts (
  id TEXT PRIMARY KEY CHECK (char_length(id) BETWEEN 1 AND 512),
  source_group_id TEXT CHECK (
    source_group_id IS NULL OR char_length(source_group_id) BETWEEN 1 AND 512
  ),
  origin_kind TEXT NOT NULL CHECK (origin_kind IN (
    'group_conclusion', 'repeated_qa', 'workflow', 'document_discussion',
    'knowledge_conflict', 'user_requested'
  )),
  status TEXT NOT NULL CHECK (status IN (
    'pending_confirmation', 'pending_review', 'needs_revision', 'rejected', 'published'
  )),
  current_revision_number INTEGER NOT NULL CHECK (current_revision_number >= 1),
  version BIGINT NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by TEXT NOT NULL CHECK (char_length(created_by) BETWEEN 1 AND 512),
  rejected_at TIMESTAMPTZ,
  rejected_by TEXT CHECK (rejected_by IS NULL OR char_length(rejected_by) BETWEEN 1 AND 512),
  rejection_reason TEXT CHECK (
    rejection_reason IS NULL OR char_length(rejection_reason) BETWEEN 1 AND 2000
  ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (id, current_revision_number),
  CHECK (
    (status = 'rejected' AND rejected_at IS NOT NULL AND rejected_by IS NOT NULL)
    OR (status <> 'rejected' AND rejected_at IS NULL AND rejected_by IS NULL
      AND rejection_reason IS NULL)
  )
);

CREATE INDEX knowledge_drafts_group_status_updated_idx
  ON knowledge_drafts (source_group_id, status, updated_at DESC, id ASC);

CREATE TABLE knowledge_draft_revisions (
  draft_id TEXT NOT NULL REFERENCES knowledge_drafts(id) ON DELETE RESTRICT,
  revision_number INTEGER NOT NULL CHECK (revision_number >= 1),
  title TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 256),
  content TEXT NOT NULL CHECK (char_length(content) BETWEEN 1 AND 100000),
  risk_level TEXT NOT NULL CHECK (risk_level IN ('low', 'medium', 'high')),
  reviewer_type TEXT CHECK (
    reviewer_type IS NULL OR reviewer_type IN ('feishu_user', 'text_label', 'admin_role')
  ),
  reviewer_ref TEXT CHECK (
    reviewer_ref IS NULL OR char_length(reviewer_ref) BETWEEN 1 AND 512
  ),
  suggested_space_id TEXT CHECK (
    suggested_space_id IS NULL OR char_length(suggested_space_id) BETWEEN 1 AND 512
  ),
  suggested_parent_node_token TEXT CHECK (
    suggested_parent_node_token IS NULL
    OR char_length(suggested_parent_node_token) BETWEEN 1 AND 512
  ),
  author TEXT NOT NULL CHECK (char_length(author) BETWEEN 1 AND 512),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (draft_id, revision_number),
  CHECK ((reviewer_type IS NULL) = (reviewer_ref IS NULL))
);

ALTER TABLE knowledge_drafts
  ADD CONSTRAINT knowledge_drafts_current_revision_fkey
  FOREIGN KEY (id, current_revision_number)
  REFERENCES knowledge_draft_revisions(draft_id, revision_number)
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE knowledge_draft_revision_evidence (
  id BIGSERIAL PRIMARY KEY,
  draft_id TEXT NOT NULL,
  revision_number INTEGER NOT NULL,
  evidence_type TEXT NOT NULL CHECK (evidence_type IN (
    'conversation_message', 'discussion_thread', 'action_item', 'document_source'
  )),
  reference_id TEXT NOT NULL CHECK (char_length(reference_id) BETWEEN 1 AND 512),
  source_group_id TEXT CHECK (
    source_group_id IS NULL OR char_length(source_group_id) BETWEEN 1 AND 512
  ),
  entity_version BIGINT CHECK (entity_version IS NULL OR entity_version >= 1),
  source_updated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (draft_id, revision_number)
    REFERENCES knowledge_draft_revisions(draft_id, revision_number) ON DELETE RESTRICT,
  UNIQUE (draft_id, revision_number, evidence_type, reference_id),
  CHECK (
    (evidence_type = 'conversation_message'
      AND source_group_id IS NOT NULL AND entity_version IS NULL AND source_updated_at IS NULL)
    OR (evidence_type IN ('discussion_thread', 'action_item')
      AND source_group_id IS NOT NULL AND entity_version IS NOT NULL AND source_updated_at IS NULL)
    OR (evidence_type = 'document_source'
      AND source_group_id IS NULL AND entity_version IS NULL AND source_updated_at IS NOT NULL)
  )
);

CREATE INDEX knowledge_draft_revision_evidence_revision_idx
  ON knowledge_draft_revision_evidence (draft_id, revision_number, id);

CREATE TABLE knowledge_draft_events (
  id TEXT PRIMARY KEY CHECK (char_length(id) BETWEEN 1 AND 512),
  draft_id TEXT NOT NULL REFERENCES knowledge_drafts(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'created', 'revised', 'revision_requested', 'rejected'
  )),
  from_version BIGINT CHECK (from_version IS NULL OR from_version >= 1),
  to_version BIGINT NOT NULL CHECK (to_version >= 1),
  operation_key TEXT NOT NULL UNIQUE CHECK (char_length(operation_key) BETWEEN 1 AND 512),
  operation_fingerprint TEXT NOT NULL CHECK (operation_fingerprint ~ '^[0-9a-f]{64}$'),
  actor TEXT NOT NULL CHECK (char_length(actor) BETWEEN 1 AND 512),
  reason TEXT CHECK (reason IS NULL OR char_length(reason) BETWEEN 1 AND 2000),
  revision_number INTEGER NOT NULL CHECK (revision_number >= 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (draft_id, revision_number)
    REFERENCES knowledge_draft_revisions(draft_id, revision_number) ON DELETE RESTRICT,
  UNIQUE (draft_id, to_version),
  CHECK (
    (event_type = 'created' AND from_version IS NULL AND to_version = 1)
    OR (event_type <> 'created' AND from_version IS NOT NULL AND to_version = from_version + 1)
  )
);

CREATE INDEX knowledge_draft_events_draft_created_idx
  ON knowledge_draft_events (draft_id, created_at ASC, id ASC);

CREATE OR REPLACE FUNCTION knowledge_draft_append_only_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'knowledge draft history is append-only';
  RETURN NULL;
END;
$$;

CREATE TRIGGER knowledge_draft_revisions_append_only
BEFORE UPDATE OR DELETE ON knowledge_draft_revisions
FOR EACH ROW EXECUTE FUNCTION knowledge_draft_append_only_guard();

CREATE TRIGGER knowledge_draft_revisions_truncate_guard
BEFORE TRUNCATE ON knowledge_draft_revisions
FOR EACH STATEMENT EXECUTE FUNCTION knowledge_draft_append_only_guard();

CREATE TRIGGER knowledge_draft_revision_evidence_append_only
BEFORE UPDATE OR DELETE ON knowledge_draft_revision_evidence
FOR EACH ROW EXECUTE FUNCTION knowledge_draft_append_only_guard();

CREATE TRIGGER knowledge_draft_revision_evidence_truncate_guard
BEFORE TRUNCATE ON knowledge_draft_revision_evidence
FOR EACH STATEMENT EXECUTE FUNCTION knowledge_draft_append_only_guard();

CREATE TRIGGER knowledge_draft_events_append_only
BEFORE UPDATE OR DELETE ON knowledge_draft_events
FOR EACH ROW EXECUTE FUNCTION knowledge_draft_append_only_guard();

CREATE TRIGGER knowledge_draft_events_truncate_guard
BEFORE TRUNCATE ON knowledge_draft_events
FOR EACH STATEMENT EXECUTE FUNCTION knowledge_draft_append_only_guard();
