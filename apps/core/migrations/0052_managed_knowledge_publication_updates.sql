ALTER TABLE action_proposals DROP CONSTRAINT action_proposals_action_type_check;
ALTER TABLE action_proposals ADD CONSTRAINT action_proposals_action_type_check
  CHECK (action_type IN ('publish_knowledge_draft', 'update_knowledge_publication'));

ALTER TABLE action_review_attestations
  ADD COLUMN action_target_fingerprint TEXT;
UPDATE action_review_attestations
SET action_target_fingerprint = content_hash;
ALTER TABLE action_review_attestations
  ADD CONSTRAINT action_review_attestations_action_target_fingerprint_check
    CHECK (action_target_fingerprint ~ '^[0-9a-f]{64}$');
ALTER TABLE action_review_attestations
  ALTER COLUMN action_target_fingerprint SET NOT NULL;

CREATE TABLE managed_knowledge_pages (
  id TEXT PRIMARY KEY CHECK (char_length(id) BETWEEN 1 AND 512),
  origin_knowledge_publication_id TEXT NOT NULL UNIQUE
    REFERENCES knowledge_publications(id) ON DELETE RESTRICT,
  target_policy_id TEXT NOT NULL REFERENCES knowledge_publication_target_policies(id) ON DELETE RESTRICT,
  target_policy_version BIGINT NOT NULL CHECK (target_policy_version >= 1),
  authorization_group_id TEXT NOT NULL CHECK (char_length(authorization_group_id) BETWEEN 1 AND 512),
  remote_node_token TEXT NOT NULL CHECK (char_length(remote_node_token) BETWEEN 1 AND 512),
  remote_document_token TEXT NOT NULL UNIQUE CHECK (char_length(remote_document_token) BETWEEN 1 AND 512),
  managed_body_block_id TEXT NOT NULL CHECK (char_length(managed_body_block_id) BETWEEN 1 AND 512),
  linked_document_source_id TEXT REFERENCES document_sources(id) ON DELETE RESTRICT,
  current_remote_revision_id TEXT CHECK (
    current_remote_revision_id IS NULL OR char_length(current_remote_revision_id) BETWEEN 1 AND 512
  ),
  current_body_content_hash TEXT CHECK (
    current_body_content_hash IS NULL OR current_body_content_hash ~ '^[0-9a-f]{64}$'
  ),
  expected_resync_content_hash TEXT CHECK (
    expected_resync_content_hash IS NULL OR expected_resync_content_hash ~ '^[0-9a-f]{64}$'
  ),
  state TEXT NOT NULL CHECK (state IN (
    'active', 'updating', 'resync_required', 'reconciliation_required', 'blocked', 'retired'
  )),
  version BIGINT NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (id, version),
  CHECK ((current_remote_revision_id IS NULL) = (current_body_content_hash IS NULL)),
  CHECK (
    (state = 'active' AND current_remote_revision_id IS NOT NULL
      AND expected_resync_content_hash IS NULL)
    OR (state = 'updating' AND current_remote_revision_id IS NOT NULL
      AND expected_resync_content_hash IS NULL)
    OR (state = 'resync_required' AND current_remote_revision_id IS NOT NULL
      AND expected_resync_content_hash IS NOT NULL)
    OR (state IN ('reconciliation_required', 'blocked', 'retired'))
  )
);

CREATE UNIQUE INDEX managed_knowledge_pages_linked_source_idx
  ON managed_knowledge_pages (linked_document_source_id)
  WHERE linked_document_source_id IS NOT NULL;

CREATE TABLE managed_knowledge_page_events (
  id TEXT PRIMARY KEY CHECK (char_length(id) BETWEEN 1 AND 512),
  managed_page_id TEXT NOT NULL REFERENCES managed_knowledge_pages(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'registered', 'source_linked', 'update_claimed', 'remote_outcome_confirmed',
    'resync_completed', 'reconciliation_required', 'blocked', 'retired', 'reactivated'
  )),
  from_version BIGINT CHECK (from_version IS NULL OR from_version >= 1),
  to_version BIGINT NOT NULL CHECK (to_version >= 1),
  operation_key TEXT NOT NULL UNIQUE CHECK (char_length(operation_key) BETWEEN 1 AND 512),
  operation_fingerprint TEXT NOT NULL CHECK (operation_fingerprint ~ '^[0-9a-f]{64}$'),
  actor TEXT CHECK (actor IS NULL OR char_length(actor) BETWEEN 1 AND 512),
  reason_code TEXT CHECK (reason_code IS NULL OR char_length(reason_code) BETWEEN 1 AND 512),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (managed_page_id, to_version),
  CHECK (
    (event_type = 'registered' AND from_version IS NULL AND to_version = 1)
    OR (event_type <> 'registered' AND from_version IS NOT NULL AND to_version = from_version + 1)
  )
);

CREATE TABLE managed_knowledge_snapshot_observations (
  id TEXT PRIMARY KEY CHECK (char_length(id) BETWEEN 1 AND 512),
  managed_page_id TEXT NOT NULL,
  managed_page_version BIGINT NOT NULL CHECK (managed_page_version >= 1),
  document_snapshot_id TEXT NOT NULL,
  document_source_id TEXT NOT NULL,
  snapshot_content_hash TEXT NOT NULL CHECK (snapshot_content_hash ~ '^[0-9a-f]{64}$'),
  observed_remote_revision_id TEXT NOT NULL CHECK (
    char_length(observed_remote_revision_id) BETWEEN 1 AND 512
  ),
  observed_managed_body_block_id TEXT NOT NULL CHECK (
    char_length(observed_managed_body_block_id) BETWEEN 1 AND 512
  ),
  observed_block_type TEXT NOT NULL CHECK (observed_block_type = 'text'),
  managed_body_content_hash TEXT NOT NULL CHECK (managed_body_content_hash ~ '^[0-9a-f]{64}$'),
  adapter_version TEXT NOT NULL CHECK (char_length(adapter_version) BETWEEN 1 AND 128),
  operation_key TEXT NOT NULL UNIQUE CHECK (char_length(operation_key) BETWEEN 1 AND 512),
  operation_fingerprint TEXT NOT NULL CHECK (operation_fingerprint ~ '^[0-9a-f]{64}$'),
  observed_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (managed_page_id)
    REFERENCES managed_knowledge_pages(id) ON DELETE RESTRICT,
  FOREIGN KEY (document_snapshot_id, document_source_id, snapshot_content_hash)
    REFERENCES document_snapshots(id, document_source_id, content_hash) ON DELETE RESTRICT,
  UNIQUE (managed_page_id, document_snapshot_id)
);

CREATE TABLE knowledge_publication_update_targets (
  id TEXT PRIMARY KEY CHECK (char_length(id) BETWEEN 1 AND 512),
  draft_id TEXT NOT NULL,
  draft_revision INTEGER NOT NULL CHECK (draft_revision >= 1),
  draft_version BIGINT NOT NULL CHECK (draft_version >= 1),
  conflict_candidate_id TEXT NOT NULL,
  conflict_candidate_version BIGINT NOT NULL CHECK (conflict_candidate_version >= 1),
  managed_page_id TEXT NOT NULL,
  managed_page_version BIGINT NOT NULL CHECK (managed_page_version >= 1),
  linked_document_source_id TEXT NOT NULL REFERENCES document_sources(id) ON DELETE RESTRICT,
  target_snapshot_id TEXT NOT NULL,
  target_snapshot_hash TEXT NOT NULL CHECK (target_snapshot_hash ~ '^[0-9a-f]{64}$'),
  target_source_version TEXT CHECK (
    target_source_version IS NULL OR char_length(target_source_version) BETWEEN 1 AND 512
  ),
  remote_document_token TEXT NOT NULL CHECK (char_length(remote_document_token) BETWEEN 1 AND 512),
  managed_body_block_id TEXT NOT NULL CHECK (char_length(managed_body_block_id) BETWEEN 1 AND 512),
  expected_remote_revision_id TEXT NOT NULL CHECK (
    char_length(expected_remote_revision_id) BETWEEN 1 AND 512
  ),
  current_body_content_hash TEXT NOT NULL CHECK (current_body_content_hash ~ '^[0-9a-f]{64}$'),
  proposed_body_content_hash TEXT NOT NULL CHECK (proposed_body_content_hash ~ '^[0-9a-f]{64}$'),
  authorization_group_id TEXT NOT NULL CHECK (char_length(authorization_group_id) BETWEEN 1 AND 512),
  target_policy_id TEXT NOT NULL REFERENCES knowledge_publication_target_policies(id) ON DELETE RESTRICT,
  target_policy_version BIGINT NOT NULL CHECK (target_policy_version >= 1),
  operation_key TEXT NOT NULL UNIQUE CHECK (char_length(operation_key) BETWEEN 1 AND 512),
  operation_fingerprint TEXT NOT NULL CHECK (operation_fingerprint ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (draft_id, draft_revision)
    REFERENCES knowledge_draft_revisions(draft_id, revision_number) ON DELETE RESTRICT,
  FOREIGN KEY (conflict_candidate_id)
    REFERENCES knowledge_conflict_candidates(id) ON DELETE RESTRICT,
  FOREIGN KEY (managed_page_id)
    REFERENCES managed_knowledge_pages(id) ON DELETE RESTRICT,
  FOREIGN KEY (target_snapshot_id, linked_document_source_id, target_snapshot_hash)
    REFERENCES document_snapshots(id, document_source_id, content_hash) ON DELETE RESTRICT,
  UNIQUE (draft_id, draft_revision),
  CHECK (proposed_body_content_hash <> current_body_content_hash)
);

CREATE TABLE knowledge_publication_update_executions (
  id TEXT PRIMARY KEY CHECK (char_length(id) BETWEEN 1 AND 512),
  proposal_id TEXT NOT NULL UNIQUE REFERENCES action_proposals(id) ON DELETE RESTRICT,
  managed_page_id TEXT NOT NULL REFERENCES managed_knowledge_pages(id) ON DELETE RESTRICT,
  managed_page_version BIGINT NOT NULL CHECK (managed_page_version >= 1),
  update_target_id TEXT NOT NULL REFERENCES knowledge_publication_update_targets(id) ON DELETE RESTRICT,
  attempt_number INTEGER NOT NULL CHECK (attempt_number >= 1),
  state TEXT NOT NULL CHECK (state IN (
    'claimed', 'preflight_failed', 'remote_request_dispatched', 'outcome_unknown', 'remote_applied',
    'resync_required', 'succeeded', 'failed', 'reconciliation_required'
  )),
  operation_key TEXT NOT NULL UNIQUE CHECK (char_length(operation_key) BETWEEN 1 AND 512),
  operation_fingerprint TEXT NOT NULL CHECK (operation_fingerprint ~ '^[0-9a-f]{64}$'),
  request_fingerprint TEXT NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  expected_remote_revision_id TEXT NOT NULL CHECK (
    char_length(expected_remote_revision_id) BETWEEN 1 AND 512
  ),
  before_body_content_hash TEXT NOT NULL CHECK (before_body_content_hash ~ '^[0-9a-f]{64}$'),
  after_body_content_hash TEXT NOT NULL CHECK (after_body_content_hash ~ '^[0-9a-f]{64}$'),
  client_token TEXT NOT NULL UNIQUE CHECK (char_length(client_token) BETWEEN 1 AND 512),
  response_revision_id TEXT CHECK (
    response_revision_id IS NULL OR char_length(response_revision_id) BETWEEN 1 AND 512
  ),
  response_classification TEXT CHECK (
    response_classification IS NULL OR char_length(response_classification) BETWEEN 1 AND 512
  ),
  reconciliation_reason_code TEXT CHECK (
    reconciliation_reason_code IS NULL OR char_length(reconciliation_reason_code) BETWEEN 1 AND 512
  ),
  remote_request_dispatched_at TIMESTAMPTZ,
  version BIGINT NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (proposal_id, attempt_number),
  CHECK (state <> 'remote_request_dispatched' OR remote_request_dispatched_at IS NOT NULL),
  CHECK (state NOT IN ('remote_applied', 'resync_required', 'succeeded') OR response_revision_id IS NOT NULL),
  CHECK (state NOT IN ('outcome_unknown', 'reconciliation_required') OR reconciliation_reason_code IS NOT NULL)
);

CREATE UNIQUE INDEX managed_knowledge_updates_one_unresolved_page_idx
  ON knowledge_publication_update_executions (managed_page_id)
  WHERE state IN (
    'claimed', 'remote_request_dispatched', 'outcome_unknown', 'remote_applied',
    'resync_required', 'reconciliation_required'
  );

CREATE TABLE knowledge_publication_update_execution_events (
  id TEXT PRIMARY KEY CHECK (char_length(id) BETWEEN 1 AND 512),
  execution_id TEXT NOT NULL REFERENCES knowledge_publication_update_executions(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL CHECK (char_length(event_type) BETWEEN 1 AND 128),
  from_version BIGINT CHECK (from_version IS NULL OR from_version >= 1),
  to_version BIGINT NOT NULL CHECK (to_version >= 1),
  operation_key TEXT NOT NULL UNIQUE CHECK (char_length(operation_key) BETWEEN 1 AND 512),
  operation_fingerprint TEXT NOT NULL CHECK (operation_fingerprint ~ '^[0-9a-f]{64}$'),
  reason_code TEXT CHECK (reason_code IS NULL OR char_length(reason_code) BETWEEN 1 AND 512),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (execution_id, to_version),
  CHECK (
    (from_version IS NULL AND to_version = 1)
    OR (from_version IS NOT NULL AND to_version = from_version + 1)
  )
);

CREATE TABLE knowledge_publication_updates (
  id TEXT PRIMARY KEY CHECK (char_length(id) BETWEEN 1 AND 512),
  origin_knowledge_publication_id TEXT NOT NULL REFERENCES knowledge_publications(id) ON DELETE RESTRICT,
  proposal_id TEXT NOT NULL UNIQUE REFERENCES action_proposals(id) ON DELETE RESTRICT,
  approval_id TEXT NOT NULL REFERENCES action_approvals(id) ON DELETE RESTRICT,
  draft_id TEXT NOT NULL,
  draft_revision INTEGER NOT NULL CHECK (draft_revision >= 1),
  conflict_candidate_id TEXT NOT NULL REFERENCES knowledge_conflict_candidates(id) ON DELETE RESTRICT,
  managed_page_id TEXT NOT NULL REFERENCES managed_knowledge_pages(id) ON DELETE RESTRICT,
  document_source_id TEXT NOT NULL REFERENCES document_sources(id) ON DELETE RESTRICT,
  execution_id TEXT NOT NULL UNIQUE REFERENCES knowledge_publication_update_executions(id) ON DELETE RESTRICT,
  before_remote_revision_id TEXT NOT NULL CHECK (char_length(before_remote_revision_id) BETWEEN 1 AND 512),
  after_remote_revision_id TEXT NOT NULL CHECK (char_length(after_remote_revision_id) BETWEEN 1 AND 512),
  before_body_content_hash TEXT NOT NULL CHECK (before_body_content_hash ~ '^[0-9a-f]{64}$'),
  after_body_content_hash TEXT NOT NULL CHECK (after_body_content_hash ~ '^[0-9a-f]{64}$'),
  executor_id TEXT NOT NULL CHECK (char_length(executor_id) BETWEEN 1 AND 512),
  operation_key TEXT NOT NULL UNIQUE CHECK (char_length(operation_key) BETWEEN 1 AND 512),
  operation_fingerprint TEXT NOT NULL CHECK (operation_fingerprint ~ '^[0-9a-f]{64}$'),
  completed_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (draft_id, draft_revision)
    REFERENCES knowledge_draft_revisions(draft_id, revision_number) ON DELETE RESTRICT
);

CREATE TRIGGER managed_knowledge_page_events_append_only
BEFORE UPDATE OR DELETE ON managed_knowledge_page_events
FOR EACH ROW EXECUTE FUNCTION knowledge_draft_append_only_guard();
CREATE TRIGGER managed_knowledge_page_events_truncate_guard
BEFORE TRUNCATE ON managed_knowledge_page_events
FOR EACH STATEMENT EXECUTE FUNCTION knowledge_draft_append_only_guard();
CREATE TRIGGER managed_knowledge_snapshot_observations_append_only
BEFORE UPDATE OR DELETE ON managed_knowledge_snapshot_observations
FOR EACH ROW EXECUTE FUNCTION knowledge_draft_append_only_guard();
CREATE TRIGGER managed_knowledge_snapshot_observations_truncate_guard
BEFORE TRUNCATE ON managed_knowledge_snapshot_observations
FOR EACH STATEMENT EXECUTE FUNCTION knowledge_draft_append_only_guard();
CREATE TRIGGER knowledge_publication_update_targets_append_only
BEFORE UPDATE OR DELETE ON knowledge_publication_update_targets
FOR EACH ROW EXECUTE FUNCTION knowledge_draft_append_only_guard();
CREATE TRIGGER knowledge_publication_update_targets_truncate_guard
BEFORE TRUNCATE ON knowledge_publication_update_targets
FOR EACH STATEMENT EXECUTE FUNCTION knowledge_draft_append_only_guard();
CREATE TRIGGER knowledge_publication_update_execution_events_append_only
BEFORE UPDATE OR DELETE ON knowledge_publication_update_execution_events
FOR EACH ROW EXECUTE FUNCTION knowledge_draft_append_only_guard();
CREATE TRIGGER knowledge_publication_update_execution_events_truncate_guard
BEFORE TRUNCATE ON knowledge_publication_update_execution_events
FOR EACH STATEMENT EXECUTE FUNCTION knowledge_draft_append_only_guard();
CREATE TRIGGER knowledge_publication_updates_append_only
BEFORE UPDATE OR DELETE ON knowledge_publication_updates
FOR EACH ROW EXECUTE FUNCTION knowledge_draft_append_only_guard();
CREATE TRIGGER knowledge_publication_updates_truncate_guard
BEFORE TRUNCATE ON knowledge_publication_updates
FOR EACH STATEMENT EXECUTE FUNCTION knowledge_draft_append_only_guard();
