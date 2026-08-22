UPDATE runtime_control_state
SET capabilities = capabilities || '{"generateTaskDrafts":false}'::jsonb
WHERE NOT (capabilities ? 'generateTaskDrafts');

UPDATE runtime_control_state
SET capabilities = capabilities || '{"createFeishuTasks":false}'::jsonb
WHERE NOT (capabilities ? 'createFeishuTasks');

ALTER TABLE approval_interaction_intents
  DROP CONSTRAINT approval_interaction_intents_interaction_kind_check;

ALTER TABLE approval_interaction_intents
  ADD CONSTRAINT approval_interaction_intents_interaction_kind_check CHECK (interaction_kind IN (
    'knowledge_draft_confirmation', 'formal_task_draft_confirmation', 'action_proposal_approval'
  ));

CREATE TABLE feishu_task_target_policies (
  id TEXT PRIMARY KEY CHECK (char_length(id) BETWEEN 1 AND 512),
  source_group_id TEXT NOT NULL CHECK (char_length(source_group_id) BETWEEN 1 AND 512),
  display_name TEXT NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 256),
  allowed_assignee_open_ids TEXT[] NOT NULL,
  max_due_horizon_days INTEGER NOT NULL CHECK (max_due_horizon_days BETWEEN 1 AND 365),
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  version BIGINT NOT NULL DEFAULT 1 CHECK (version >= 1),
  operation_key TEXT NOT NULL UNIQUE CHECK (char_length(operation_key) BETWEEN 1 AND 512),
  operation_fingerprint TEXT NOT NULL CHECK (operation_fingerprint ~ '^[0-9a-f]{64}$'),
  created_by TEXT NOT NULL CHECK (char_length(created_by) BETWEEN 1 AND 512),
  updated_by TEXT NOT NULL CHECK (char_length(updated_by) BETWEEN 1 AND 512),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (cardinality(allowed_assignee_open_ids) BETWEEN 1 AND 100),
  CHECK (array_position(allowed_assignee_open_ids, '') IS NULL),
  UNIQUE (source_group_id)
);

CREATE TABLE feishu_task_target_policy_operations (
  operation_key TEXT PRIMARY KEY CHECK (char_length(operation_key) BETWEEN 1 AND 512),
  operation_fingerprint TEXT NOT NULL CHECK (operation_fingerprint ~ '^[0-9a-f]{64}$'),
  policy_id TEXT NOT NULL REFERENCES feishu_task_target_policies(id) ON DELETE RESTRICT,
  resulting_version BIGINT NOT NULL CHECK (resulting_version >= 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE formal_task_drafts (
  id TEXT PRIMARY KEY CHECK (char_length(id) BETWEEN 1 AND 512),
  source_group_id TEXT NOT NULL CHECK (char_length(source_group_id) BETWEEN 1 AND 512),
  status TEXT NOT NULL CHECK (status IN (
    'pending_confirmation', 'pending_review', 'needs_revision', 'rejected', 'created'
  )),
  current_revision_number INTEGER NOT NULL CHECK (current_revision_number >= 1),
  version BIGINT NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by TEXT NOT NULL CHECK (char_length(created_by) BETWEEN 1 AND 512),
  current_task_spec_hash TEXT NOT NULL CHECK (current_task_spec_hash ~ '^[0-9a-f]{64}$'),
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

CREATE INDEX formal_task_drafts_group_status_updated_idx
  ON formal_task_drafts (source_group_id, status, updated_at DESC, id ASC);

CREATE TABLE formal_task_draft_revisions (
  draft_id TEXT NOT NULL REFERENCES formal_task_drafts(id) ON DELETE RESTRICT,
  revision_number INTEGER NOT NULL CHECK (revision_number >= 1),
  title TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 256),
  description TEXT NOT NULL CHECK (char_length(description) BETWEEN 1 AND 3000),
  assignee_open_id TEXT NOT NULL CHECK (char_length(assignee_open_id) BETWEEN 1 AND 512),
  due_at TIMESTAMPTZ,
  reminder_minutes INTEGER,
  risk_level TEXT NOT NULL CHECK (risk_level IN ('low', 'medium', 'high')),
  target_policy_id TEXT NOT NULL REFERENCES feishu_task_target_policies(id) ON DELETE RESTRICT,
  target_policy_version BIGINT NOT NULL CHECK (target_policy_version >= 1),
  task_spec_hash TEXT NOT NULL CHECK (task_spec_hash ~ '^[0-9a-f]{64}$'),
  author TEXT NOT NULL CHECK (char_length(author) BETWEEN 1 AND 512),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (draft_id, revision_number),
  CHECK (reminder_minutes IS NULL OR reminder_minutes IN (0, 30, 60, 1440)),
  CHECK (reminder_minutes IS NULL OR due_at IS NOT NULL)
);

ALTER TABLE formal_task_drafts
  ADD CONSTRAINT formal_task_drafts_current_revision_fkey
  FOREIGN KEY (id, current_revision_number)
  REFERENCES formal_task_draft_revisions(draft_id, revision_number)
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE formal_task_draft_evidence (
  id BIGSERIAL PRIMARY KEY,
  draft_id TEXT NOT NULL,
  revision_number INTEGER NOT NULL,
  source_group_id TEXT NOT NULL CHECK (char_length(source_group_id) BETWEEN 1 AND 512),
  conversation_message_id TEXT,
  action_item_id TEXT,
  action_item_version BIGINT CHECK (action_item_version IS NULL OR action_item_version >= 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (draft_id, revision_number)
    REFERENCES formal_task_draft_revisions(draft_id, revision_number) ON DELETE RESTRICT,
  FOREIGN KEY (conversation_message_id, source_group_id)
    REFERENCES conversation_messages(id, chat_id) ON DELETE RESTRICT,
  FOREIGN KEY (action_item_id, source_group_id)
    REFERENCES action_items(id, group_id) ON DELETE RESTRICT,
  CHECK (
    (conversation_message_id IS NOT NULL AND action_item_id IS NULL AND action_item_version IS NULL)
    OR (conversation_message_id IS NULL AND action_item_id IS NOT NULL
      AND action_item_version IS NOT NULL)
  ),
  UNIQUE (draft_id, revision_number, conversation_message_id),
  UNIQUE (draft_id, revision_number, action_item_id, action_item_version)
);

CREATE INDEX formal_task_draft_evidence_message_idx
  ON formal_task_draft_evidence (conversation_message_id, draft_id)
  WHERE conversation_message_id IS NOT NULL;

CREATE INDEX formal_task_draft_evidence_action_idx
  ON formal_task_draft_evidence (action_item_id, action_item_version, draft_id)
  WHERE action_item_id IS NOT NULL;

CREATE TABLE formal_task_draft_events (
  id TEXT PRIMARY KEY CHECK (char_length(id) BETWEEN 1 AND 512),
  draft_id TEXT NOT NULL REFERENCES formal_task_drafts(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'created', 'revised', 'group_confirmed', 'revision_requested', 'rejected', 'task_created'
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
    REFERENCES formal_task_draft_revisions(draft_id, revision_number) ON DELETE RESTRICT,
  UNIQUE (draft_id, to_version),
  CHECK (
    (event_type = 'created' AND from_version IS NULL AND to_version = 1)
    OR (event_type <> 'created' AND from_version IS NOT NULL AND to_version = from_version + 1)
  )
);

CREATE INDEX formal_task_draft_events_draft_created_idx
  ON formal_task_draft_events (draft_id, created_at ASC, id ASC);

CREATE TABLE formal_task_draft_presentations (
  id TEXT PRIMARY KEY CHECK (char_length(id) BETWEEN 1 AND 512),
  draft_id TEXT NOT NULL,
  draft_revision INTEGER NOT NULL CHECK (draft_revision >= 1),
  draft_version BIGINT NOT NULL CHECK (draft_version >= 1),
  task_spec_hash TEXT NOT NULL CHECK (task_spec_hash ~ '^[0-9a-f]{64}$'),
  group_id TEXT NOT NULL CHECK (char_length(group_id) BETWEEN 1 AND 512),
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
  FOREIGN KEY (draft_id, draft_revision)
    REFERENCES formal_task_draft_revisions(draft_id, revision_number) ON DELETE RESTRICT,
  CHECK (
    (state = 'active' AND message_id IS NOT NULL AND activated_at IS NOT NULL
      AND closed_at IS NULL)
    OR (state = 'closed' AND closed_at IS NOT NULL)
    OR (state IN ('pending_send', 'superseded', 'send_failed') AND closed_at IS NULL)
  )
);

CREATE UNIQUE INDEX formal_task_draft_presentations_one_active_idx
  ON formal_task_draft_presentations (draft_id, draft_revision, group_id)
  WHERE state = 'active';

CREATE TABLE formal_task_draft_presentation_events (
  id TEXT PRIMARY KEY CHECK (char_length(id) BETWEEN 1 AND 512),
  presentation_id TEXT NOT NULL REFERENCES formal_task_draft_presentations(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'created', 'send_succeeded', 'send_failed', 'confirmed', 'revision_requested',
    'rejected', 'superseded', 'card_update_succeeded', 'card_update_failed'
  )),
  actor_open_id TEXT CHECK (actor_open_id IS NULL OR char_length(actor_open_id) BETWEEN 1 AND 512),
  callback_event_id TEXT UNIQUE CHECK (
    callback_event_id IS NULL OR char_length(callback_event_id) BETWEEN 1 AND 512
  ),
  operation_key TEXT NOT NULL UNIQUE CHECK (char_length(operation_key) BETWEEN 1 AND 512),
  from_version BIGINT CHECK (from_version IS NULL OR from_version >= 1),
  to_version BIGINT NOT NULL CHECK (to_version >= 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE action_proposals
  DROP CONSTRAINT action_proposals_action_type_check,
  DROP CONSTRAINT action_proposals_subject_type_check,
  ALTER COLUMN subject_id DROP NOT NULL,
  ALTER COLUMN subject_revision DROP NOT NULL,
  ALTER COLUMN subject_version DROP NOT NULL,
  ALTER COLUMN target_policy_id DROP NOT NULL,
  ALTER COLUMN target_policy_version DROP NOT NULL,
  ADD COLUMN task_draft_id TEXT,
  ADD COLUMN task_draft_revision INTEGER,
  ADD COLUMN task_draft_version BIGINT,
  ADD COLUMN task_target_policy_id TEXT
    REFERENCES feishu_task_target_policies(id) ON DELETE RESTRICT,
  ADD COLUMN task_target_policy_version BIGINT,
  ADD COLUMN task_assignee_open_id TEXT,
  ADD COLUMN task_due_at TIMESTAMPTZ,
  ADD COLUMN task_reminder_minutes INTEGER,
  ADD COLUMN task_spec_hash TEXT,
  ADD COLUMN task_group_confirmation_presentation_id TEXT
    REFERENCES formal_task_draft_presentations(id) ON DELETE RESTRICT,
  ADD CONSTRAINT action_proposals_action_type_check CHECK (action_type IN (
    'publish_knowledge_draft', 'update_knowledge_publication', 'create_feishu_task'
  )),
  ADD CONSTRAINT action_proposals_subject_type_check CHECK (subject_type IN (
    'knowledge_draft', 'formal_task_draft'
  )),
  ADD CONSTRAINT action_proposals_task_draft_fkey
    FOREIGN KEY (task_draft_id, task_draft_revision)
    REFERENCES formal_task_draft_revisions(draft_id, revision_number) ON DELETE RESTRICT,
  ADD CONSTRAINT action_proposals_action_binding_check CHECK (
    (
      action_type IN ('publish_knowledge_draft', 'update_knowledge_publication')
      AND subject_type = 'knowledge_draft'
      AND subject_id IS NOT NULL AND subject_revision IS NOT NULL
      AND subject_version IS NOT NULL
      AND target_policy_id IS NOT NULL AND target_policy_version IS NOT NULL
      AND task_draft_id IS NULL AND task_draft_revision IS NULL
      AND task_draft_version IS NULL
      AND task_target_policy_id IS NULL AND task_target_policy_version IS NULL
      AND task_assignee_open_id IS NULL AND task_due_at IS NULL
      AND task_reminder_minutes IS NULL AND task_spec_hash IS NULL
      AND task_group_confirmation_presentation_id IS NULL
    ) OR (
      action_type = 'create_feishu_task'
      AND subject_type = 'formal_task_draft'
      AND subject_id IS NULL AND subject_revision IS NULL AND subject_version IS NULL
      AND target_policy_id IS NULL AND target_policy_version IS NULL
      AND task_draft_id IS NOT NULL AND task_draft_revision IS NOT NULL
      AND task_draft_version IS NOT NULL AND task_draft_version >= 1
      AND task_target_policy_id IS NOT NULL
      AND task_target_policy_version IS NOT NULL AND task_target_policy_version >= 1
      AND task_assignee_open_id IS NOT NULL
      AND char_length(task_assignee_open_id) BETWEEN 1 AND 512
      AND (task_reminder_minutes IS NULL OR task_reminder_minutes IN (0, 30, 60, 1440))
      AND (task_reminder_minutes IS NULL OR task_due_at IS NOT NULL)
      AND task_spec_hash ~ '^[0-9a-f]{64}$'
      AND task_group_confirmation_presentation_id IS NOT NULL
    )
  );

CREATE UNIQUE INDEX action_proposals_one_live_formal_task_idx
  ON action_proposals (task_draft_id, task_draft_revision)
  WHERE action_type = 'create_feishu_task'
    AND status IN ('pending_approval', 'approved', 'executing', 'reconciliation_required');

ALTER TABLE action_approval_requirements
  ALTER COLUMN target_policy_id DROP NOT NULL,
  ALTER COLUMN target_policy_version DROP NOT NULL,
  ADD COLUMN task_target_policy_id TEXT
    REFERENCES feishu_task_target_policies(id) ON DELETE RESTRICT,
  ADD COLUMN task_target_policy_version BIGINT,
  ADD CONSTRAINT action_approval_requirements_policy_binding_check CHECK (
    (
      target_policy_id IS NOT NULL AND target_policy_version IS NOT NULL
      AND target_policy_version >= 1
      AND task_target_policy_id IS NULL AND task_target_policy_version IS NULL
    ) OR (
      target_policy_id IS NULL AND target_policy_version IS NULL
      AND task_target_policy_id IS NOT NULL
      AND task_target_policy_version IS NOT NULL AND task_target_policy_version >= 1
    )
  );

CREATE TABLE formal_task_draft_presentation_outbox (
  id TEXT PRIMARY KEY CHECK (char_length(id) BETWEEN 1 AND 512),
  presentation_id TEXT NOT NULL UNIQUE
    REFERENCES formal_task_draft_presentations(id) ON DELETE RESTRICT,
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

CREATE INDEX formal_task_draft_presentation_outbox_ready_idx
  ON formal_task_draft_presentation_outbox (state, retry_at ASC, created_at ASC, id ASC);

CREATE TABLE feishu_task_creation_executions (
  id TEXT PRIMARY KEY CHECK (char_length(id) BETWEEN 1 AND 512),
  proposal_id TEXT NOT NULL REFERENCES action_proposals(id) ON DELETE RESTRICT,
  approval_id TEXT NOT NULL REFERENCES action_approvals(id) ON DELETE RESTRICT,
  draft_id TEXT NOT NULL,
  draft_revision INTEGER NOT NULL CHECK (draft_revision >= 1),
  draft_version BIGINT NOT NULL CHECK (draft_version >= 1),
  target_policy_id TEXT NOT NULL REFERENCES feishu_task_target_policies(id) ON DELETE RESTRICT,
  target_policy_version BIGINT NOT NULL CHECK (target_policy_version >= 1),
  assignee_open_id TEXT NOT NULL CHECK (char_length(assignee_open_id) BETWEEN 1 AND 512),
  attempt_number INTEGER NOT NULL CHECK (attempt_number >= 1),
  state TEXT NOT NULL CHECK (state IN (
    'claimed', 'external_attempting', 'succeeded', 'failed', 'outcome_unknown',
    'reconciliation_required'
  )),
  request_fingerprint TEXT NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  client_token_hash TEXT NOT NULL CHECK (client_token_hash ~ '^[0-9a-f]{64}$'),
  operation_key TEXT NOT NULL UNIQUE CHECK (char_length(operation_key) BETWEEN 1 AND 512),
  response_classification TEXT CHECK (
    response_classification IS NULL OR char_length(response_classification) BETWEEN 1 AND 512
  ),
  remote_task_guid TEXT CHECK (
    remote_task_guid IS NULL OR char_length(remote_task_guid) BETWEEN 1 AND 512
  ),
  remote_task_id TEXT CHECK (
    remote_task_id IS NULL OR char_length(remote_task_id) BETWEEN 1 AND 512
  ),
  remote_task_url TEXT CHECK (
    remote_task_url IS NULL OR (
      char_length(remote_task_url) BETWEEN 12 AND 2048 AND remote_task_url ~ '^https://'
    )
  ),
  worker_id TEXT CHECK (worker_id IS NULL OR char_length(worker_id) BETWEEN 1 AND 512),
  lease_until TIMESTAMPTZ,
  retry_at TIMESTAMPTZ,
  version BIGINT NOT NULL DEFAULT 1 CHECK (version >= 1),
  dispatched_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (draft_id, draft_revision)
    REFERENCES formal_task_draft_revisions(draft_id, revision_number) ON DELETE RESTRICT,
  UNIQUE (proposal_id, attempt_number),
  CHECK (
    state <> 'succeeded' OR (
      remote_task_guid IS NOT NULL AND remote_task_id IS NOT NULL AND remote_task_url IS NOT NULL
    )
  )
);

CREATE UNIQUE INDEX feishu_task_creation_one_unresolved_proposal_idx
  ON feishu_task_creation_executions (proposal_id)
  WHERE state IN (
    'claimed', 'external_attempting', 'outcome_unknown', 'reconciliation_required'
  );

CREATE INDEX feishu_task_creation_executions_ready_idx
  ON feishu_task_creation_executions (state, retry_at ASC, created_at ASC, id ASC);

CREATE TABLE feishu_task_creation_execution_events (
  id TEXT PRIMARY KEY CHECK (char_length(id) BETWEEN 1 AND 512),
  execution_id TEXT NOT NULL
    REFERENCES feishu_task_creation_executions(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'claimed', 'request_dispatched', 'succeeded', 'failed', 'outcome_unknown',
    'reconciliation_required'
  )),
  operation_key TEXT NOT NULL UNIQUE CHECK (char_length(operation_key) BETWEEN 1 AND 512),
  from_version BIGINT CHECK (from_version IS NULL OR from_version >= 1),
  to_version BIGINT NOT NULL CHECK (to_version >= 1),
  response_classification TEXT CHECK (
    response_classification IS NULL OR char_length(response_classification) BETWEEN 1 AND 512
  ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE feishu_task_creations (
  id TEXT PRIMARY KEY CHECK (char_length(id) BETWEEN 1 AND 512),
  proposal_id TEXT NOT NULL UNIQUE REFERENCES action_proposals(id) ON DELETE RESTRICT,
  approval_id TEXT NOT NULL REFERENCES action_approvals(id) ON DELETE RESTRICT,
  execution_id TEXT NOT NULL UNIQUE
    REFERENCES feishu_task_creation_executions(id) ON DELETE RESTRICT,
  draft_id TEXT NOT NULL,
  draft_revision INTEGER NOT NULL CHECK (draft_revision >= 1),
  draft_version BIGINT NOT NULL CHECK (draft_version >= 1),
  target_policy_id TEXT NOT NULL REFERENCES feishu_task_target_policies(id) ON DELETE RESTRICT,
  target_policy_version BIGINT NOT NULL CHECK (target_policy_version >= 1),
  assignee_open_id TEXT NOT NULL CHECK (char_length(assignee_open_id) BETWEEN 1 AND 512),
  due_at TIMESTAMPTZ,
  reminder_minutes INTEGER,
  remote_task_guid TEXT NOT NULL CHECK (char_length(remote_task_guid) BETWEEN 1 AND 512),
  remote_task_id TEXT NOT NULL CHECK (char_length(remote_task_id) BETWEEN 1 AND 512),
  remote_task_url TEXT NOT NULL CHECK (
    char_length(remote_task_url) BETWEEN 12 AND 2048 AND remote_task_url ~ '^https://'
  ),
  task_spec_hash TEXT NOT NULL CHECK (task_spec_hash ~ '^[0-9a-f]{64}$'),
  operation_key TEXT NOT NULL UNIQUE CHECK (char_length(operation_key) BETWEEN 1 AND 512),
  operation_fingerprint TEXT NOT NULL CHECK (operation_fingerprint ~ '^[0-9a-f]{64}$'),
  completed_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (draft_id, draft_revision)
    REFERENCES formal_task_draft_revisions(draft_id, revision_number) ON DELETE RESTRICT,
  CHECK (reminder_minutes IS NULL OR reminder_minutes IN (0, 30, 60, 1440)),
  CHECK (reminder_minutes IS NULL OR due_at IS NOT NULL)
);

CREATE UNIQUE INDEX feishu_task_creations_remote_guid_idx
  ON feishu_task_creations (remote_task_guid);

CREATE TABLE feishu_task_result_presentations (
  id TEXT PRIMARY KEY CHECK (char_length(id) BETWEEN 1 AND 512),
  creation_id TEXT NOT NULL UNIQUE REFERENCES feishu_task_creations(id) ON DELETE RESTRICT,
  proposal_id TEXT NOT NULL UNIQUE REFERENCES action_proposals(id) ON DELETE RESTRICT,
  group_id TEXT NOT NULL CHECK (char_length(group_id) BETWEEN 1 AND 512),
  state TEXT NOT NULL CHECK (state IN (
    'pending_send', 'sent', 'failed', 'outcome_unknown'
  )),
  message_id TEXT CHECK (message_id IS NULL OR char_length(message_id) BETWEEN 1 AND 512),
  operation_key TEXT NOT NULL UNIQUE CHECK (char_length(operation_key) BETWEEN 1 AND 512),
  operation_fingerprint TEXT NOT NULL CHECK (operation_fingerprint ~ '^[0-9a-f]{64}$'),
  version BIGINT NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (
    (state = 'sent' AND message_id IS NOT NULL AND sent_at IS NOT NULL)
    OR (state <> 'sent' AND sent_at IS NULL)
  )
);

CREATE TABLE feishu_task_result_presentation_events (
  id TEXT PRIMARY KEY CHECK (char_length(id) BETWEEN 1 AND 512),
  presentation_id TEXT NOT NULL REFERENCES feishu_task_result_presentations(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'created', 'send_succeeded', 'send_failed', 'outcome_unknown'
  )),
  operation_key TEXT NOT NULL UNIQUE CHECK (char_length(operation_key) BETWEEN 1 AND 512),
  from_version BIGINT CHECK (from_version IS NULL OR from_version >= 1),
  to_version BIGINT NOT NULL CHECK (to_version >= 1),
  response_classification TEXT CHECK (
    response_classification IS NULL OR char_length(response_classification) BETWEEN 1 AND 512
  ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE feishu_task_result_presentation_outbox (
  id TEXT PRIMARY KEY CHECK (char_length(id) BETWEEN 1 AND 512),
  presentation_id TEXT NOT NULL UNIQUE
    REFERENCES feishu_task_result_presentations(id) ON DELETE RESTRICT,
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

CREATE INDEX feishu_task_result_presentation_outbox_ready_idx
  ON feishu_task_result_presentation_outbox (state, retry_at ASC, created_at ASC, id ASC);

CREATE OR REPLACE FUNCTION formal_task_append_only_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'formal task history is append-only';
  RETURN NULL;
END;
$$;

CREATE TRIGGER feishu_task_target_policy_operations_append_only
BEFORE UPDATE OR DELETE ON feishu_task_target_policy_operations
FOR EACH ROW EXECUTE FUNCTION formal_task_append_only_guard();
CREATE TRIGGER feishu_task_target_policy_operations_truncate_guard
BEFORE TRUNCATE ON feishu_task_target_policy_operations
FOR EACH STATEMENT EXECUTE FUNCTION formal_task_append_only_guard();

CREATE TRIGGER formal_task_draft_revisions_append_only
BEFORE UPDATE OR DELETE ON formal_task_draft_revisions
FOR EACH ROW EXECUTE FUNCTION formal_task_append_only_guard();
CREATE TRIGGER formal_task_draft_revisions_truncate_guard
BEFORE TRUNCATE ON formal_task_draft_revisions
FOR EACH STATEMENT EXECUTE FUNCTION formal_task_append_only_guard();

CREATE TRIGGER formal_task_draft_evidence_append_only
BEFORE UPDATE OR DELETE ON formal_task_draft_evidence
FOR EACH ROW EXECUTE FUNCTION formal_task_append_only_guard();
CREATE TRIGGER formal_task_draft_evidence_truncate_guard
BEFORE TRUNCATE ON formal_task_draft_evidence
FOR EACH STATEMENT EXECUTE FUNCTION formal_task_append_only_guard();

CREATE TRIGGER formal_task_draft_events_append_only
BEFORE UPDATE OR DELETE ON formal_task_draft_events
FOR EACH ROW EXECUTE FUNCTION formal_task_append_only_guard();
CREATE TRIGGER formal_task_draft_events_truncate_guard
BEFORE TRUNCATE ON formal_task_draft_events
FOR EACH STATEMENT EXECUTE FUNCTION formal_task_append_only_guard();

CREATE TRIGGER formal_task_draft_presentation_events_append_only
BEFORE UPDATE OR DELETE ON formal_task_draft_presentation_events
FOR EACH ROW EXECUTE FUNCTION formal_task_append_only_guard();
CREATE TRIGGER formal_task_draft_presentation_events_truncate_guard
BEFORE TRUNCATE ON formal_task_draft_presentation_events
FOR EACH STATEMENT EXECUTE FUNCTION formal_task_append_only_guard();

CREATE TRIGGER feishu_task_creation_execution_events_append_only
BEFORE UPDATE OR DELETE ON feishu_task_creation_execution_events
FOR EACH ROW EXECUTE FUNCTION formal_task_append_only_guard();
CREATE TRIGGER feishu_task_creation_execution_events_truncate_guard
BEFORE TRUNCATE ON feishu_task_creation_execution_events
FOR EACH STATEMENT EXECUTE FUNCTION formal_task_append_only_guard();

CREATE TRIGGER feishu_task_creations_append_only
BEFORE UPDATE OR DELETE ON feishu_task_creations
FOR EACH ROW EXECUTE FUNCTION formal_task_append_only_guard();
CREATE TRIGGER feishu_task_creations_truncate_guard
BEFORE TRUNCATE ON feishu_task_creations
FOR EACH STATEMENT EXECUTE FUNCTION formal_task_append_only_guard();

CREATE TRIGGER feishu_task_result_presentation_events_append_only
BEFORE UPDATE OR DELETE ON feishu_task_result_presentation_events
FOR EACH ROW EXECUTE FUNCTION formal_task_append_only_guard();
CREATE TRIGGER feishu_task_result_presentation_events_truncate_guard
BEFORE TRUNCATE ON feishu_task_result_presentation_events
FOR EACH STATEMENT EXECUTE FUNCTION formal_task_append_only_guard();
