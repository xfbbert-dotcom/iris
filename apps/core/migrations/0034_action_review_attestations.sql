CREATE TABLE action_review_attestations (
  id TEXT PRIMARY KEY CHECK (char_length(id) BETWEEN 1 AND 512),
  proposal_id TEXT NOT NULL REFERENCES action_proposals(id) ON DELETE RESTRICT,
  actor_open_id TEXT NOT NULL CHECK (char_length(actor_open_id) BETWEEN 1 AND 512),
  subject_revision INTEGER NOT NULL CHECK (subject_revision >= 1),
  subject_version BIGINT NOT NULL CHECK (subject_version >= 1),
  proposal_version BIGINT NOT NULL CHECK (proposal_version >= 1),
  content_hash TEXT NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  session_id_hash TEXT NOT NULL CHECK (session_id_hash ~ '^[0-9a-f]{64}$'),
  operation_key TEXT NOT NULL UNIQUE CHECK (char_length(operation_key) BETWEEN 1 AND 512),
  operation_fingerprint TEXT NOT NULL CHECK (operation_fingerprint ~ '^[0-9a-f]{64}$'),
  reviewed_at TIMESTAMPTZ NOT NULL,
  UNIQUE (proposal_id, proposal_version, actor_open_id, content_hash)
);

CREATE TRIGGER action_review_attestations_append_only
BEFORE UPDATE OR DELETE ON action_review_attestations
FOR EACH ROW EXECUTE FUNCTION knowledge_draft_append_only_guard();

CREATE TRIGGER action_review_attestations_truncate_guard
BEFORE TRUNCATE ON action_review_attestations
FOR EACH STATEMENT EXECUTE FUNCTION knowledge_draft_append_only_guard();
