CREATE TABLE knowledge_publications (
  id TEXT PRIMARY KEY CHECK (char_length(id) BETWEEN 1 AND 512),
  proposal_id TEXT NOT NULL REFERENCES action_proposals(id) ON DELETE RESTRICT,
  execution_id TEXT NOT NULL REFERENCES action_executions(id) ON DELETE RESTRICT,
  draft_id TEXT NOT NULL CHECK (char_length(draft_id) BETWEEN 1 AND 512),
  revision_number INTEGER NOT NULL CHECK (revision_number >= 1),
  draft_version BIGINT NOT NULL CHECK (draft_version >= 1),
  target_policy_id TEXT NOT NULL REFERENCES knowledge_publication_target_policies(id),
  target_policy_version BIGINT NOT NULL CHECK (target_policy_version >= 1),
  space_id TEXT NOT NULL CHECK (char_length(space_id) BETWEEN 1 AND 512),
  remote_node_token TEXT NOT NULL CHECK (char_length(remote_node_token) BETWEEN 1 AND 512),
  remote_document_token TEXT NOT NULL CHECK (char_length(remote_document_token) BETWEEN 1 AND 512),
  remote_document_type TEXT NOT NULL CHECK (char_length(remote_document_type) BETWEEN 1 AND 64),
  remote_document_version TEXT CHECK (
    remote_document_version IS NULL OR char_length(remote_document_version) BETWEEN 1 AND 512
  ),
  content_hash TEXT NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  permission_check_summary TEXT NOT NULL CHECK (char_length(permission_check_summary) BETWEEN 1 AND 512),
  operation_key TEXT NOT NULL UNIQUE CHECK (char_length(operation_key) BETWEEN 1 AND 512),
  operation_fingerprint TEXT NOT NULL CHECK (operation_fingerprint ~ '^[0-9a-f]{64}$'),
  published_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (draft_id, revision_number),
  UNIQUE (proposal_id),
  UNIQUE (execution_id),
  FOREIGN KEY (draft_id, revision_number)
    REFERENCES knowledge_draft_revisions(draft_id, revision_number) ON DELETE RESTRICT
);

ALTER TABLE knowledge_draft_events
  DROP CONSTRAINT knowledge_draft_events_event_type_check;

ALTER TABLE knowledge_draft_events
  ADD CONSTRAINT knowledge_draft_events_event_type_check CHECK (event_type IN (
    'created', 'revised', 'group_confirmed', 'review_approved', 'approval_invalidated',
    'publication_succeeded', 'revision_requested', 'rejected'
  ));

CREATE TRIGGER knowledge_publications_append_only
BEFORE UPDATE OR DELETE ON knowledge_publications
FOR EACH ROW EXECUTE FUNCTION knowledge_draft_append_only_guard();

CREATE TRIGGER knowledge_publications_truncate_guard
BEFORE TRUNCATE ON knowledge_publications
FOR EACH STATEMENT EXECUTE FUNCTION knowledge_draft_append_only_guard();
