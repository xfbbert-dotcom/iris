CREATE TABLE document_source_group_grants (
  id TEXT PRIMARY KEY CHECK (char_length(id) BETWEEN 1 AND 512),
  document_source_id TEXT NOT NULL
    REFERENCES document_sources(id) ON DELETE RESTRICT
    CHECK (char_length(document_source_id) BETWEEN 1 AND 512),
  grantor_group_id TEXT NOT NULL CHECK (char_length(grantor_group_id) BETWEEN 1 AND 512),
  grantee_group_id TEXT NOT NULL CHECK (char_length(grantee_group_id) BETWEEN 1 AND 512),
  state TEXT NOT NULL CHECK (state IN ('active', 'revoked')),
  version BIGINT NOT NULL CHECK (version >= 1),
  created_by TEXT NOT NULL CHECK (char_length(created_by) BETWEEN 1 AND 512),
  updated_by TEXT NOT NULL CHECK (char_length(updated_by) BETWEEN 1 AND 512),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE (document_source_id, grantee_group_id),
  CHECK (grantor_group_id <> grantee_group_id)
);

CREATE INDEX document_source_group_grants_grantee_state_idx
  ON document_source_group_grants (grantee_group_id, state, updated_at DESC, id ASC);

CREATE TABLE document_source_group_grant_events (
  id TEXT PRIMARY KEY CHECK (char_length(id) BETWEEN 1 AND 512),
  grant_id TEXT NOT NULL REFERENCES document_source_group_grants(id) ON DELETE RESTRICT
    CHECK (char_length(grant_id) BETWEEN 1 AND 512),
  event_type TEXT NOT NULL CHECK (event_type IN ('granted', 'revoked')),
  from_version BIGINT CHECK (from_version IS NULL OR from_version >= 1),
  to_version BIGINT NOT NULL CHECK (to_version >= 1),
  operation_key TEXT NOT NULL UNIQUE CHECK (char_length(operation_key) BETWEEN 1 AND 512),
  operation_fingerprint TEXT NOT NULL CHECK (operation_fingerprint ~ '^[0-9a-f]{64}$'),
  actor_ref TEXT NOT NULL CHECK (char_length(actor_ref) BETWEEN 1 AND 512),
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (grant_id, to_version),
  CHECK (
    (from_version IS NULL AND to_version = 1)
    OR (from_version IS NOT NULL AND to_version = from_version + 1)
  )
);

CREATE INDEX document_source_group_grant_events_grant_idx
  ON document_source_group_grant_events (grant_id, created_at, id);

CREATE TRIGGER document_source_group_grant_events_append_only
BEFORE UPDATE OR DELETE ON document_source_group_grant_events
FOR EACH ROW EXECUTE FUNCTION knowledge_draft_append_only_guard();

CREATE TRIGGER document_source_group_grant_events_truncate_guard
BEFORE TRUNCATE ON document_source_group_grant_events
FOR EACH STATEMENT EXECUTE FUNCTION knowledge_draft_append_only_guard();

ALTER TABLE answer_reply_source_traces
  ADD COLUMN cross_group_grant_id TEXT,
  ADD COLUMN cross_group_grant_version BIGINT,
  ADD COLUMN cross_group_grantor_group_id TEXT,
  ADD COLUMN cross_group_grantee_group_id TEXT;

ALTER TABLE answer_reply_source_traces
  ADD CONSTRAINT answer_reply_source_traces_cross_group_grant_fkey
  FOREIGN KEY (cross_group_grant_id)
  REFERENCES document_source_group_grants(id) ON DELETE RESTRICT;

ALTER TABLE answer_reply_source_traces
  ADD CONSTRAINT answer_reply_source_traces_cross_group_grant_shape_check CHECK (
    (
      cross_group_grant_id IS NULL
      AND cross_group_grant_version IS NULL
      AND cross_group_grantor_group_id IS NULL
      AND cross_group_grantee_group_id IS NULL
    )
    OR (
      cross_group_grant_id IS NOT NULL
      AND char_length(cross_group_grant_id) BETWEEN 1 AND 512
      AND cross_group_grant_version IS NOT NULL
      AND cross_group_grant_version >= 1
      AND cross_group_grantor_group_id IS NOT NULL
      AND char_length(cross_group_grantor_group_id) BETWEEN 1 AND 512
      AND cross_group_grantee_group_id IS NOT NULL
      AND char_length(cross_group_grantee_group_id) BETWEEN 1 AND 512
      AND cross_group_grantor_group_id <> cross_group_grantee_group_id
      AND source_type = 'feishu_group_document'
    )
  );
