CREATE TABLE knowledge_publication_target_policies (
  id TEXT PRIMARY KEY CHECK (char_length(id) BETWEEN 1 AND 512),
  space_id TEXT NOT NULL CHECK (char_length(space_id) BETWEEN 1 AND 512),
  parent_node_token TEXT CHECK (
    parent_node_token IS NULL OR char_length(parent_node_token) BETWEEN 1 AND 512
  ),
  display_name TEXT NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 256),
  allowed_group_ids TEXT[] NOT NULL DEFAULT '{}',
  allowed_risk_levels TEXT[] NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  version BIGINT NOT NULL DEFAULT 1 CHECK (version >= 1),
  operation_key TEXT NOT NULL UNIQUE CHECK (char_length(operation_key) BETWEEN 1 AND 512),
  operation_fingerprint TEXT NOT NULL CHECK (operation_fingerprint ~ '^[0-9a-f]{64}$'),
  created_by TEXT NOT NULL CHECK (char_length(created_by) BETWEEN 1 AND 512),
  updated_by TEXT NOT NULL CHECK (char_length(updated_by) BETWEEN 1 AND 512),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (cardinality(allowed_group_ids) BETWEEN 0 AND 100),
  CHECK (cardinality(allowed_risk_levels) BETWEEN 1 AND 3),
  CHECK (allowed_risk_levels <@ ARRAY['low', 'medium', 'high']::TEXT[]),
  UNIQUE (space_id, parent_node_token)
);

CREATE TABLE action_role_grants (
  role_type TEXT NOT NULL CHECK (role_type IN ('iris_admin', 'authorized_high_risk_owner')),
  actor_open_id TEXT NOT NULL CHECK (char_length(actor_open_id) BETWEEN 1 AND 512),
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  version BIGINT NOT NULL DEFAULT 1 CHECK (version >= 1),
  operation_key TEXT NOT NULL UNIQUE CHECK (char_length(operation_key) BETWEEN 1 AND 512),
  operation_fingerprint TEXT NOT NULL CHECK (operation_fingerprint ~ '^[0-9a-f]{64}$'),
  created_by TEXT NOT NULL CHECK (char_length(created_by) BETWEEN 1 AND 512),
  updated_by TEXT NOT NULL CHECK (char_length(updated_by) BETWEEN 1 AND 512),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (role_type, actor_open_id)
);

CREATE TABLE action_target_policy_operations (
  operation_key TEXT PRIMARY KEY CHECK (char_length(operation_key) BETWEEN 1 AND 512),
  operation_fingerprint TEXT NOT NULL CHECK (operation_fingerprint ~ '^[0-9a-f]{64}$'),
  policy_id TEXT NOT NULL REFERENCES knowledge_publication_target_policies(id) ON DELETE RESTRICT,
  resulting_version BIGINT NOT NULL CHECK (resulting_version >= 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE action_role_grant_operations (
  operation_key TEXT PRIMARY KEY CHECK (char_length(operation_key) BETWEEN 1 AND 512),
  operation_fingerprint TEXT NOT NULL CHECK (operation_fingerprint ~ '^[0-9a-f]{64}$'),
  role_type TEXT NOT NULL,
  actor_open_id TEXT NOT NULL,
  resulting_version BIGINT NOT NULL CHECK (resulting_version >= 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (role_type, actor_open_id)
    REFERENCES action_role_grants(role_type, actor_open_id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX knowledge_publication_target_policies_destination_idx
  ON knowledge_publication_target_policies (space_id, COALESCE(parent_node_token, ''));

CREATE TABLE action_proposals (
  id TEXT PRIMARY KEY CHECK (char_length(id) BETWEEN 1 AND 512),
  action_type TEXT NOT NULL CHECK (action_type = 'publish_knowledge_draft'),
  subject_type TEXT NOT NULL CHECK (subject_type = 'knowledge_draft'),
  subject_id TEXT NOT NULL CHECK (char_length(subject_id) BETWEEN 1 AND 512),
  subject_revision INTEGER NOT NULL CHECK (subject_revision >= 1),
  subject_version BIGINT NOT NULL CHECK (subject_version >= 1),
  target_policy_id TEXT NOT NULL REFERENCES knowledge_publication_target_policies(id),
  target_policy_version BIGINT NOT NULL CHECK (target_policy_version >= 1),
  risk_level TEXT NOT NULL CHECK (risk_level IN ('low', 'medium', 'high')),
  status TEXT NOT NULL CHECK (status IN (
    'pending_approval', 'approved', 'executing', 'succeeded', 'failed',
    'cancelled', 'expired', 'reconciliation_required'
  )),
  operation_key TEXT NOT NULL UNIQUE CHECK (char_length(operation_key) BETWEEN 1 AND 512),
  operation_fingerprint TEXT NOT NULL CHECK (operation_fingerprint ~ '^[0-9a-f]{64}$'),
  version BIGINT NOT NULL DEFAULT 1 CHECK (version >= 1),
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (subject_id, subject_revision)
    REFERENCES knowledge_draft_revisions(draft_id, revision_number) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX action_proposals_one_live_subject_idx
  ON action_proposals (subject_id, subject_revision)
  WHERE status IN ('pending_approval', 'approved', 'executing', 'reconciliation_required');

CREATE INDEX action_proposals_status_updated_idx
  ON action_proposals (status, updated_at ASC, id ASC);

CREATE TABLE action_approval_requirements (
  id TEXT PRIMARY KEY CHECK (char_length(id) BETWEEN 1 AND 512),
  proposal_id TEXT NOT NULL REFERENCES action_proposals(id) ON DELETE RESTRICT,
  requirement_kind TEXT NOT NULL CHECK (requirement_kind IN (
    'group_confirmation', 'designated_owner', 'iris_admin_or_authorized_owner'
  )),
  role_ref_type TEXT NOT NULL CHECK (role_ref_type IN (
    'source_group', 'feishu_user', 'unassigned'
  )),
  role_ref TEXT CHECK (role_ref IS NULL OR char_length(role_ref) BETWEEN 1 AND 512),
  target_policy_id TEXT NOT NULL REFERENCES knowledge_publication_target_policies(id),
  target_policy_version BIGINT NOT NULL CHECK (target_policy_version >= 1),
  state TEXT NOT NULL CHECK (state IN ('pending', 'satisfied', 'invalidated')),
  satisfied_actor_open_id TEXT CHECK (
    satisfied_actor_open_id IS NULL OR char_length(satisfied_actor_open_id) BETWEEN 1 AND 512
  ),
  satisfied_source_type TEXT CHECK (
    satisfied_source_type IS NULL OR satisfied_source_type IN ('group_confirmation', 'action_approval')
  ),
  satisfied_source_id TEXT CHECK (
    satisfied_source_id IS NULL OR char_length(satisfied_source_id) BETWEEN 1 AND 512
  ),
  version BIGINT NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK ((role_ref_type = 'unassigned') = (role_ref IS NULL)),
  CHECK (
    (state = 'satisfied' AND satisfied_actor_open_id IS NOT NULL
      AND satisfied_source_type IS NOT NULL AND satisfied_source_id IS NOT NULL)
    OR (state <> 'satisfied' AND satisfied_actor_open_id IS NULL
      AND satisfied_source_type IS NULL AND satisfied_source_id IS NULL)
  )
);

CREATE UNIQUE INDEX action_approval_requirements_identity_idx
  ON action_approval_requirements (
    proposal_id, requirement_kind, role_ref_type, COALESCE(role_ref, '')
  );

CREATE TABLE action_approval_presentations (
  id TEXT PRIMARY KEY CHECK (char_length(id) BETWEEN 1 AND 512),
  proposal_id TEXT NOT NULL REFERENCES action_proposals(id) ON DELETE RESTRICT,
  requirement_id TEXT NOT NULL REFERENCES action_approval_requirements(id) ON DELETE RESTRICT,
  proposal_version BIGINT NOT NULL CHECK (proposal_version >= 1),
  recipient_open_id TEXT NOT NULL CHECK (char_length(recipient_open_id) BETWEEN 1 AND 512),
  state TEXT NOT NULL CHECK (state IN (
    'pending_send', 'active', 'superseded', 'closed', 'send_failed'
  )),
  message_id TEXT CHECK (message_id IS NULL OR char_length(message_id) BETWEEN 1 AND 512),
  operation_key TEXT NOT NULL UNIQUE CHECK (char_length(operation_key) BETWEEN 1 AND 512),
  operation_fingerprint TEXT NOT NULL CHECK (operation_fingerprint ~ '^[0-9a-f]{64}$'),
  version BIGINT NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  activated_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ,
  CHECK (
    (state = 'active' AND message_id IS NOT NULL AND activated_at IS NOT NULL AND closed_at IS NULL)
    OR (state = 'closed' AND closed_at IS NOT NULL)
    OR (state IN ('pending_send', 'superseded', 'send_failed') AND closed_at IS NULL)
  )
);

CREATE UNIQUE INDEX action_approval_presentations_one_active_recipient_idx
  ON action_approval_presentations (proposal_id, requirement_id, recipient_open_id)
  WHERE state = 'active';

CREATE TABLE action_approval_presentation_events (
  id TEXT PRIMARY KEY CHECK (char_length(id) BETWEEN 1 AND 512),
  presentation_id TEXT NOT NULL REFERENCES action_approval_presentations(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'created', 'send_succeeded', 'send_failed', 'approved', 'revision_requested',
    'rejected', 'superseded', 'card_update_succeeded', 'card_update_failed'
  )),
  actor_open_id TEXT CHECK (actor_open_id IS NULL OR char_length(actor_open_id) BETWEEN 1 AND 512),
  operation_key TEXT NOT NULL UNIQUE CHECK (char_length(operation_key) BETWEEN 1 AND 512),
  callback_event_id TEXT UNIQUE CHECK (
    callback_event_id IS NULL OR char_length(callback_event_id) BETWEEN 1 AND 512
  ),
  from_version BIGINT CHECK (from_version IS NULL OR from_version >= 1),
  to_version BIGINT NOT NULL CHECK (to_version >= 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE action_approval_presentation_outbox (
  id TEXT PRIMARY KEY CHECK (char_length(id) BETWEEN 1 AND 512),
  presentation_id TEXT NOT NULL UNIQUE
    REFERENCES action_approval_presentations(id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL UNIQUE CHECK (char_length(idempotency_key) BETWEEN 1 AND 512),
  state TEXT NOT NULL CHECK (state IN (
    'pending', 'processing', 'external_attempting', 'sent', 'failed', 'outcome_unknown'
  )),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  worker_id TEXT CHECK (worker_id IS NULL OR char_length(worker_id) BETWEEN 1 AND 512),
  lease_until TIMESTAMPTZ,
  retry_at TIMESTAMPTZ,
  error_code TEXT CHECK (error_code IS NULL OR char_length(error_code) BETWEEN 1 AND 512),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX action_approval_presentation_outbox_ready_idx
  ON action_approval_presentation_outbox (state, retry_at ASC, created_at ASC, id ASC);

CREATE TABLE action_approvals (
  id TEXT PRIMARY KEY CHECK (char_length(id) BETWEEN 1 AND 512),
  proposal_id TEXT NOT NULL REFERENCES action_proposals(id) ON DELETE RESTRICT,
  requirement_id TEXT NOT NULL REFERENCES action_approval_requirements(id) ON DELETE RESTRICT,
  actor_open_id TEXT NOT NULL CHECK (char_length(actor_open_id) BETWEEN 1 AND 512),
  source_presentation_id TEXT NOT NULL
    REFERENCES action_approval_presentations(id) ON DELETE RESTRICT,
  callback_event_id TEXT NOT NULL UNIQUE CHECK (char_length(callback_event_id) BETWEEN 1 AND 512),
  subject_revision INTEGER NOT NULL CHECK (subject_revision >= 1),
  subject_version BIGINT NOT NULL CHECK (subject_version >= 1),
  authorization_summary TEXT NOT NULL CHECK (char_length(authorization_summary) BETWEEN 1 AND 512),
  operation_key TEXT NOT NULL UNIQUE CHECK (char_length(operation_key) BETWEEN 1 AND 512),
  operation_fingerprint TEXT NOT NULL CHECK (operation_fingerprint ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX action_approvals_one_requirement_actor_idx
  ON action_approvals (proposal_id, requirement_id, actor_open_id);

CREATE TABLE action_events (
  id TEXT PRIMARY KEY CHECK (char_length(id) BETWEEN 1 AND 512),
  proposal_id TEXT NOT NULL REFERENCES action_proposals(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'created', 'approval_recorded', 'requirements_satisfied', 'revision_requested',
    'rejected', 'approval_invalidated', 'cancelled', 'expired', 'execution_started',
    'execution_succeeded', 'execution_failed', 'execution_reconciliation_required'
  )),
  actor_open_id TEXT CHECK (actor_open_id IS NULL OR char_length(actor_open_id) BETWEEN 1 AND 512),
  operation_key TEXT NOT NULL UNIQUE CHECK (char_length(operation_key) BETWEEN 1 AND 512),
  from_version BIGINT CHECK (from_version IS NULL OR from_version >= 1),
  to_version BIGINT NOT NULL CHECK (to_version >= 1),
  reason_code TEXT CHECK (reason_code IS NULL OR char_length(reason_code) BETWEEN 1 AND 512),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE action_executions (
  id TEXT PRIMARY KEY CHECK (char_length(id) BETWEEN 1 AND 512),
  proposal_id TEXT NOT NULL REFERENCES action_proposals(id) ON DELETE RESTRICT,
  attempt_number INTEGER NOT NULL CHECK (attempt_number >= 1),
  state TEXT NOT NULL CHECK (state IN (
    'pending', 'executing', 'succeeded', 'failed', 'outcome_unknown', 'reconciliation_required'
  )),
  request_fingerprint TEXT NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  provider TEXT NOT NULL CHECK (char_length(provider) BETWEEN 1 AND 64),
  response_classification TEXT CHECK (
    response_classification IS NULL OR char_length(response_classification) BETWEEN 1 AND 512
  ),
  remote_node_token TEXT CHECK (
    remote_node_token IS NULL OR char_length(remote_node_token) BETWEEN 1 AND 512
  ),
  remote_document_token TEXT CHECK (
    remote_document_token IS NULL OR char_length(remote_document_token) BETWEEN 1 AND 512
  ),
  version BIGINT NOT NULL DEFAULT 1 CHECK (version >= 1),
  retry_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (proposal_id, attempt_number)
);

CREATE TABLE action_execution_events (
  id TEXT PRIMARY KEY CHECK (char_length(id) BETWEEN 1 AND 512),
  execution_id TEXT NOT NULL REFERENCES action_executions(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'started', 'succeeded', 'failed', 'outcome_unknown', 'reconciliation_required'
  )),
  operation_key TEXT NOT NULL UNIQUE CHECK (char_length(operation_key) BETWEEN 1 AND 512),
  from_version BIGINT CHECK (from_version IS NULL OR from_version >= 1),
  to_version BIGINT NOT NULL CHECK (to_version >= 1),
  response_classification TEXT CHECK (
    response_classification IS NULL OR char_length(response_classification) BETWEEN 1 AND 512
  ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE knowledge_draft_events
  DROP CONSTRAINT knowledge_draft_events_event_type_check;

ALTER TABLE knowledge_draft_events
  ADD CONSTRAINT knowledge_draft_events_event_type_check CHECK (event_type IN (
    'created', 'revised', 'group_confirmed', 'review_approved', 'approval_invalidated',
    'revision_requested', 'rejected'
  ));

CREATE TRIGGER action_approvals_append_only
BEFORE UPDATE OR DELETE ON action_approvals
FOR EACH ROW EXECUTE FUNCTION knowledge_draft_append_only_guard();

CREATE TRIGGER action_approvals_truncate_guard
BEFORE TRUNCATE ON action_approvals
FOR EACH STATEMENT EXECUTE FUNCTION knowledge_draft_append_only_guard();

CREATE TRIGGER action_target_policy_operations_append_only
BEFORE UPDATE OR DELETE ON action_target_policy_operations
FOR EACH ROW EXECUTE FUNCTION knowledge_draft_append_only_guard();

CREATE TRIGGER action_target_policy_operations_truncate_guard
BEFORE TRUNCATE ON action_target_policy_operations
FOR EACH STATEMENT EXECUTE FUNCTION knowledge_draft_append_only_guard();

CREATE TRIGGER action_role_grant_operations_append_only
BEFORE UPDATE OR DELETE ON action_role_grant_operations
FOR EACH ROW EXECUTE FUNCTION knowledge_draft_append_only_guard();

CREATE TRIGGER action_role_grant_operations_truncate_guard
BEFORE TRUNCATE ON action_role_grant_operations
FOR EACH STATEMENT EXECUTE FUNCTION knowledge_draft_append_only_guard();

CREATE TRIGGER action_events_append_only
BEFORE UPDATE OR DELETE ON action_events
FOR EACH ROW EXECUTE FUNCTION knowledge_draft_append_only_guard();

CREATE TRIGGER action_events_truncate_guard
BEFORE TRUNCATE ON action_events
FOR EACH STATEMENT EXECUTE FUNCTION knowledge_draft_append_only_guard();

CREATE TRIGGER action_approval_presentation_events_append_only
BEFORE UPDATE OR DELETE ON action_approval_presentation_events
FOR EACH ROW EXECUTE FUNCTION knowledge_draft_append_only_guard();

CREATE TRIGGER action_approval_presentation_events_truncate_guard
BEFORE TRUNCATE ON action_approval_presentation_events
FOR EACH STATEMENT EXECUTE FUNCTION knowledge_draft_append_only_guard();

CREATE TRIGGER action_execution_events_append_only
BEFORE UPDATE OR DELETE ON action_execution_events
FOR EACH ROW EXECUTE FUNCTION knowledge_draft_append_only_guard();

CREATE TRIGGER action_execution_events_truncate_guard
BEFORE TRUNCATE ON action_execution_events
FOR EACH STATEMENT EXECUTE FUNCTION knowledge_draft_append_only_guard();
