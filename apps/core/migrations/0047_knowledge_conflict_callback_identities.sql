CREATE TABLE knowledge_conflict_callback_identities (
  id TEXT PRIMARY KEY CHECK (char_length(id) BETWEEN 1 AND 512),
  callback_key TEXT NOT NULL UNIQUE CHECK (char_length(callback_key) BETWEEN 1 AND 512),
  event_id TEXT NOT NULL CHECK (char_length(event_id) BETWEEN 1 AND 512),
  app_id TEXT NOT NULL CHECK (char_length(app_id) BETWEEN 1 AND 512),
  actor_open_id TEXT NOT NULL CHECK (char_length(actor_open_id) BETWEEN 1 AND 512),
  chat_id TEXT NOT NULL CHECK (char_length(chat_id) BETWEEN 1 AND 512),
  message_id TEXT NOT NULL CHECK (char_length(message_id) BETWEEN 1 AND 512),
  presentation_id TEXT NOT NULL CHECK (char_length(presentation_id) BETWEEN 1 AND 512),
  candidate_id TEXT NOT NULL CHECK (char_length(candidate_id) BETWEEN 1 AND 512),
  candidate_version BIGINT NOT NULL CHECK (candidate_version >= 1),
  group_id TEXT NOT NULL CHECK (char_length(group_id) BETWEEN 1 AND 512),
  nonce TEXT NOT NULL CHECK (char_length(nonce) BETWEEN 1 AND 128),
  action TEXT NOT NULL CHECK (action IN ('create_update_draft', 'not_a_conflict')),
  operation_fingerprint TEXT NOT NULL CHECK (operation_fingerprint ~ '^[0-9a-f]{64}$'),
  received_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (presentation_id = candidate_id),
  CHECK (chat_id = group_id)
);

CREATE TRIGGER knowledge_conflict_callback_identities_append_only
BEFORE UPDATE OR DELETE ON knowledge_conflict_callback_identities
FOR EACH ROW EXECUTE FUNCTION knowledge_draft_append_only_guard();

CREATE TABLE knowledge_conflict_draft_governance_attestations (
  draft_id TEXT NOT NULL REFERENCES knowledge_drafts(id) ON DELETE RESTRICT,
  revision_number INTEGER NOT NULL CHECK (revision_number >= 1),
  document_source_id TEXT NOT NULL REFERENCES document_sources(id) ON DELETE RESTRICT,
  permission_attested_at TIMESTAMPTZ NOT NULL,
  target_policy_id TEXT NOT NULL REFERENCES knowledge_publication_target_policies(id) ON DELETE RESTRICT,
  target_policy_version BIGINT NOT NULL CHECK (target_policy_version >= 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (draft_id, revision_number, document_source_id),
  FOREIGN KEY (draft_id, revision_number)
    REFERENCES knowledge_draft_revisions(draft_id, revision_number) ON DELETE RESTRICT
);

CREATE TRIGGER knowledge_conflict_draft_governance_attestations_append_only
BEFORE UPDATE OR DELETE ON knowledge_conflict_draft_governance_attestations
FOR EACH ROW EXECUTE FUNCTION knowledge_draft_append_only_guard();
