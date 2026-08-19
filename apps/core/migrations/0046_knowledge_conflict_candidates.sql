ALTER TABLE document_snapshots
  ADD CONSTRAINT document_snapshots_exact_identity_key
  UNIQUE (id, document_source_id, content_hash);

ALTER TABLE document_fragments
  ADD CONSTRAINT document_fragments_exact_identity_key
  UNIQUE (id, document_source_id, document_snapshot_id, content_hash);

CREATE TABLE knowledge_conflict_scan_inbox (
  id TEXT PRIMARY KEY CHECK (char_length(id) BETWEEN 1 AND 512),
  group_id TEXT NOT NULL CHECK (char_length(group_id) BETWEEN 1 AND 512),
  group_memory_id TEXT NOT NULL CHECK (char_length(group_memory_id) BETWEEN 1 AND 512),
  memory_updated_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL CONSTRAINT knowledge_conflict_scan_inbox_status_check CHECK (
    status IN ('pending', 'processing', 'retry', 'completed', 'dead_lettered')
  ),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 20),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  lease_worker_id TEXT CHECK (
    lease_worker_id IS NULL OR char_length(lease_worker_id) BETWEEN 1 AND 512
  ),
  lease_until TIMESTAMPTZ,
  terminal_outcome TEXT CHECK (
    terminal_outcome IS NULL
    OR terminal_outcome IN (
      'conflict', 'no_conflict', 'insufficient_evidence', 'superseded', 'permission_blocked'
    )
  ),
  last_error_code TEXT CHECK (
    last_error_code IS NULL OR char_length(last_error_code) BETWEEN 1 AND 128
  ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT knowledge_conflict_scan_memory_version_key
    UNIQUE (group_memory_id, memory_updated_at),
  FOREIGN KEY (group_memory_id, group_id)
    REFERENCES group_memories(id, group_id) ON DELETE RESTRICT,
  CHECK (
    (status = 'processing' AND lease_worker_id IS NOT NULL AND lease_until IS NOT NULL)
    OR (status <> 'processing' AND lease_worker_id IS NULL AND lease_until IS NULL)
  ),
  CHECK (
    (status = 'completed' AND terminal_outcome IS NOT NULL)
    OR (status <> 'completed' AND terminal_outcome IS NULL)
  )
);

CREATE INDEX knowledge_conflict_scan_inbox_due_idx
  ON knowledge_conflict_scan_inbox (status, next_attempt_at, created_at, id)
  WHERE status IN ('pending', 'retry');

CREATE TABLE knowledge_conflict_scan_operations (
  operation_key TEXT PRIMARY KEY CHECK (char_length(operation_key) BETWEEN 1 AND 512),
  scan_id TEXT NOT NULL CHECK (char_length(scan_id) BETWEEN 1 AND 512),
  group_id TEXT NOT NULL CHECK (char_length(group_id) BETWEEN 1 AND 512),
  actor_ref TEXT NOT NULL CHECK (char_length(actor_ref) BETWEEN 1 AND 512),
  action TEXT NOT NULL CHECK (action IN ('replay', 'delete')),
  expected_attempt_count INTEGER NOT NULL CHECK (expected_attempt_count BETWEEN 1 AND 20),
  expected_updated_at TIMESTAMPTZ NOT NULL,
  result_status TEXT NOT NULL CHECK (result_status IN ('pending', 'deleted')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX knowledge_conflict_scan_operations_scan_idx
  ON knowledge_conflict_scan_operations (scan_id, created_at, operation_key);

CREATE TABLE knowledge_conflict_candidates (
  id TEXT PRIMARY KEY CHECK (char_length(id) BETWEEN 1 AND 512),
  idempotency_key TEXT NOT NULL UNIQUE CHECK (char_length(idempotency_key) BETWEEN 1 AND 512),
  group_id TEXT NOT NULL CHECK (char_length(group_id) BETWEEN 1 AND 512),
  group_memory_id TEXT NOT NULL CHECK (char_length(group_memory_id) BETWEEN 1 AND 512),
  memory_updated_at TIMESTAMPTZ NOT NULL,
  source_message_id TEXT NOT NULL CHECK (char_length(source_message_id) BETWEEN 1 AND 512),
  target_document_source_id TEXT NOT NULL CHECK (
    char_length(target_document_source_id) BETWEEN 1 AND 512
  ),
  target_source_updated_at TIMESTAMPTZ NOT NULL,
  target_source_version TEXT CHECK (
    target_source_version IS NULL OR char_length(target_source_version) BETWEEN 1 AND 512
  ),
  target_snapshot_id TEXT NOT NULL CHECK (char_length(target_snapshot_id) BETWEEN 1 AND 512),
  target_content_hash TEXT NOT NULL CHECK (target_content_hash ~ '^[0-9a-f]{64}$'),
  detector_contract_version TEXT NOT NULL CHECK (
    char_length(detector_contract_version) BETWEEN 1 AND 128
  ),
  status TEXT NOT NULL CONSTRAINT knowledge_conflict_candidates_status_check CHECK (
    status IN (
      'pending_review', 'dismissed', 'approved_for_delivery',
      'delivered', 'draft_created', 'superseded'
    )
  ),
  subject TEXT NOT NULL CHECK (char_length(subject) BETWEEN 1 AND 256),
  knowledge_base_statement TEXT NOT NULL CHECK (
    char_length(knowledge_base_statement) BETWEEN 1 AND 4000
  ),
  group_conclusion_statement TEXT NOT NULL CHECK (
    char_length(group_conclusion_statement) BETWEEN 1 AND 4000
  ),
  difference TEXT NOT NULL CHECK (char_length(difference) BETWEEN 1 AND 4000),
  suggested_update TEXT NOT NULL CHECK (char_length(suggested_update) BETWEEN 1 AND 4000),
  target_document_ref TEXT NOT NULL CHECK (target_document_ref ~ '^D([1-9]|1[0-2])$'),
  confidence TEXT NOT NULL CHECK (confidence IN ('high', 'medium')),
  version BIGINT NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (group_memory_id, group_id)
    REFERENCES group_memories(id, group_id) ON DELETE RESTRICT,
  FOREIGN KEY (source_message_id, group_id)
    REFERENCES conversation_messages(id, chat_id) ON DELETE RESTRICT,
  FOREIGN KEY (target_document_source_id)
    REFERENCES document_sources(id) ON DELETE RESTRICT,
  CONSTRAINT knowledge_conflict_candidates_target_snapshot_fkey
    FOREIGN KEY (target_snapshot_id, target_document_source_id, target_content_hash)
    REFERENCES document_snapshots(id, document_source_id, content_hash) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX knowledge_conflict_one_live_evidence_idx
  ON knowledge_conflict_candidates (
    group_memory_id, memory_updated_at, target_snapshot_id, target_content_hash,
    detector_contract_version
  );

CREATE INDEX knowledge_conflict_candidates_group_status_idx
  ON knowledge_conflict_candidates (group_id, status, updated_at DESC, id ASC);

CREATE TABLE knowledge_conflict_evidence (
  id BIGSERIAL PRIMARY KEY,
  candidate_id TEXT NOT NULL REFERENCES knowledge_conflict_candidates(id) ON DELETE RESTRICT,
  evidence_type TEXT NOT NULL CONSTRAINT knowledge_conflict_evidence_evidence_type_check CHECK (
    evidence_type IN (
      'conversation_message', 'group_memory', 'document_source',
      'document_snapshot', 'document_fragment'
    )
  ),
  reference_id TEXT NOT NULL CHECK (char_length(reference_id) BETWEEN 1 AND 512),
  group_id TEXT CHECK (group_id IS NULL OR char_length(group_id) BETWEEN 1 AND 512),
  conversation_message_id TEXT,
  group_memory_id TEXT,
  source_updated_at TIMESTAMPTZ,
  document_source_id TEXT,
  document_snapshot_id TEXT,
  document_fragment_id TEXT,
  snapshot_content_hash TEXT CHECK (
    snapshot_content_hash IS NULL OR snapshot_content_hash ~ '^[0-9a-f]{64}$'
  ),
  content_hash TEXT CHECK (content_hash IS NULL OR content_hash ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT knowledge_conflict_evidence_reference_key
    UNIQUE (candidate_id, evidence_type, reference_id),
  CONSTRAINT knowledge_conflict_evidence_reference_kind_check CHECK (
    (evidence_type = 'conversation_message' AND reference_id ~ '^C([1-9]|10)$')
    OR (evidence_type = 'group_memory' AND reference_id = 'M1')
    OR (evidence_type IN ('document_source', 'document_snapshot', 'document_fragment')
      AND reference_id ~ '^D([1-9]|1[0-2])$')
  ),
  FOREIGN KEY (conversation_message_id, group_id)
    REFERENCES conversation_messages(id, chat_id) ON DELETE RESTRICT,
  FOREIGN KEY (group_memory_id, group_id)
    REFERENCES group_memories(id, group_id) ON DELETE RESTRICT,
  FOREIGN KEY (document_source_id) REFERENCES document_sources(id) ON DELETE RESTRICT,
  CONSTRAINT knowledge_conflict_evidence_snapshot_identity_fkey
    FOREIGN KEY (document_snapshot_id, document_source_id, snapshot_content_hash)
    REFERENCES document_snapshots(id, document_source_id, content_hash) ON DELETE RESTRICT,
  CONSTRAINT knowledge_conflict_evidence_fragment_identity_fkey
    FOREIGN KEY (
      document_fragment_id, document_source_id, document_snapshot_id, content_hash
    ) REFERENCES document_fragments(
      id, document_source_id, document_snapshot_id, content_hash
    ) ON DELETE RESTRICT,
  CHECK (
    (evidence_type = 'conversation_message'
      AND group_id IS NOT NULL AND conversation_message_id IS NOT NULL
      AND group_memory_id IS NULL AND source_updated_at IS NULL
      AND document_source_id IS NULL AND document_snapshot_id IS NULL
      AND document_fragment_id IS NULL AND snapshot_content_hash IS NULL
      AND content_hash IS NULL)
    OR (evidence_type = 'group_memory'
      AND group_id IS NOT NULL AND conversation_message_id IS NULL
      AND group_memory_id IS NOT NULL AND source_updated_at IS NOT NULL
      AND document_source_id IS NULL AND document_snapshot_id IS NULL
      AND document_fragment_id IS NULL AND snapshot_content_hash IS NULL
      AND content_hash IS NULL)
    OR (evidence_type = 'document_source'
      AND group_id IS NULL AND conversation_message_id IS NULL
      AND group_memory_id IS NULL AND source_updated_at IS NOT NULL
      AND document_source_id IS NOT NULL AND document_snapshot_id IS NULL
      AND document_fragment_id IS NULL AND snapshot_content_hash IS NULL
      AND content_hash IS NULL)
    OR (evidence_type = 'document_snapshot'
      AND group_id IS NULL AND conversation_message_id IS NULL
      AND group_memory_id IS NULL AND source_updated_at IS NULL
      AND document_source_id IS NOT NULL AND document_snapshot_id IS NOT NULL
      AND document_fragment_id IS NULL AND snapshot_content_hash IS NOT NULL
      AND content_hash = snapshot_content_hash)
    OR (evidence_type = 'document_fragment'
      AND group_id IS NULL AND conversation_message_id IS NULL
      AND group_memory_id IS NULL AND source_updated_at IS NULL
      AND document_source_id IS NOT NULL AND document_snapshot_id IS NOT NULL
      AND document_fragment_id IS NOT NULL AND snapshot_content_hash IS NOT NULL
      AND content_hash IS NOT NULL)
  )
);

CREATE INDEX knowledge_conflict_evidence_candidate_idx
  ON knowledge_conflict_evidence (candidate_id, evidence_type, reference_id);

CREATE TABLE knowledge_conflict_candidate_events (
  id TEXT PRIMARY KEY CHECK (char_length(id) BETWEEN 1 AND 512),
  candidate_id TEXT NOT NULL REFERENCES knowledge_conflict_candidates(id) ON DELETE RESTRICT,
  operation_key TEXT NOT NULL UNIQUE CHECK (char_length(operation_key) BETWEEN 1 AND 512),
  actor_type TEXT NOT NULL CHECK (actor_type IN ('system', 'feishu_user', 'admin_role')),
  actor_ref TEXT NOT NULL CHECK (char_length(actor_ref) BETWEEN 1 AND 512),
  from_status TEXT CHECK (
    from_status IS NULL OR from_status IN (
      'pending_review', 'dismissed', 'approved_for_delivery',
      'delivered', 'draft_created', 'superseded'
    )
  ),
  to_status TEXT NOT NULL CHECK (
    to_status IN (
      'pending_review', 'dismissed', 'approved_for_delivery',
      'delivered', 'draft_created', 'superseded'
    )
  ),
  from_version BIGINT CHECK (from_version IS NULL OR from_version >= 1),
  to_version BIGINT NOT NULL CHECK (to_version >= 1),
  reason_code TEXT NOT NULL CHECK (char_length(reason_code) BETWEEN 1 AND 128),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (candidate_id, to_version),
  CHECK (
    (from_version IS NULL AND to_version = 1 AND from_status IS NULL)
    OR (from_version IS NOT NULL AND to_version = from_version + 1 AND from_status IS NOT NULL)
  )
);

CREATE INDEX knowledge_conflict_candidate_events_candidate_idx
  ON knowledge_conflict_candidate_events (candidate_id, created_at, id);

CREATE TABLE knowledge_conflict_delivery_outbox (
  id TEXT PRIMARY KEY CHECK (char_length(id) BETWEEN 1 AND 512),
  candidate_id TEXT NOT NULL REFERENCES knowledge_conflict_candidates(id) ON DELETE RESTRICT,
  group_id TEXT NOT NULL CHECK (char_length(group_id) BETWEEN 1 AND 512),
  status TEXT NOT NULL CONSTRAINT knowledge_conflict_delivery_outbox_status_check CHECK (
    status IN (
      'pending', 'processing', 'external_attempting', 'sent',
      'failed', 'outcome_unknown', 'cancelled'
    )
  ),
  retryable BOOLEAN NOT NULL DEFAULT TRUE,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 20),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  lease_worker_id TEXT CHECK (
    lease_worker_id IS NULL OR char_length(lease_worker_id) BETWEEN 1 AND 512
  ),
  lease_until TIMESTAMPTZ,
  external_attempt_started_at TIMESTAMPTZ,
  reconciliation_due_at TIMESTAMPTZ,
  reconciliation_operation_key TEXT UNIQUE CHECK (
    reconciliation_operation_key IS NULL
    OR char_length(reconciliation_operation_key) BETWEEN 1 AND 512
  ),
  reconciliation_outcome TEXT CHECK (
    reconciliation_outcome IS NULL OR reconciliation_outcome IN ('sent', 'not_sent')
  ),
  reconciled_at TIMESTAMPTZ,
  sent_message_id TEXT CHECK (
    sent_message_id IS NULL OR char_length(sent_message_id) BETWEEN 1 AND 512
  ),
  failure_code TEXT CHECK (
    failure_code IS NULL OR char_length(failure_code) BETWEEN 1 AND 128
  ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (
    (status IN ('processing', 'external_attempting')
      AND lease_worker_id IS NOT NULL AND lease_until IS NOT NULL)
    OR (status NOT IN ('processing', 'external_attempting')
      AND lease_worker_id IS NULL AND lease_until IS NULL)
  ),
  CHECK (status <> 'external_attempting' OR external_attempt_started_at IS NOT NULL),
  CHECK (status <> 'outcome_unknown' OR reconciliation_due_at IS NOT NULL),
  CHECK (
    (reconciliation_operation_key IS NULL
      AND reconciliation_outcome IS NULL AND reconciled_at IS NULL)
    OR (reconciliation_operation_key IS NOT NULL
      AND reconciliation_outcome IS NOT NULL AND reconciled_at IS NOT NULL)
  ),
  CHECK (status <> 'sent' OR sent_message_id IS NOT NULL),
  CHECK (status = 'failed' OR retryable = TRUE)
);

CREATE UNIQUE INDEX knowledge_conflict_one_delivery_idx
  ON knowledge_conflict_delivery_outbox (candidate_id);

CREATE INDEX knowledge_conflict_delivery_outbox_due_idx
  ON knowledge_conflict_delivery_outbox (status, next_attempt_at, created_at, id)
  WHERE status IN ('pending', 'failed');

CREATE TABLE knowledge_conflict_delivery_reconciliations (
  operation_key TEXT PRIMARY KEY CHECK (char_length(operation_key) BETWEEN 1 AND 512),
  delivery_id TEXT NOT NULL
    REFERENCES knowledge_conflict_delivery_outbox(id) ON DELETE RESTRICT,
  attempt_count INTEGER NOT NULL CHECK (attempt_count BETWEEN 1 AND 20),
  outcome TEXT NOT NULL CHECK (outcome IN ('sent', 'not_sent')),
  sent_message_id TEXT CHECK (
    sent_message_id IS NULL OR char_length(sent_message_id) BETWEEN 1 AND 512
  ),
  actor_ref TEXT NOT NULL CHECK (char_length(actor_ref) BETWEEN 1 AND 512),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK ((outcome = 'sent') = (sent_message_id IS NOT NULL))
);

CREATE INDEX knowledge_conflict_delivery_reconciliations_delivery_idx
  ON knowledge_conflict_delivery_reconciliations (delivery_id, attempt_count, created_at);

CREATE TABLE knowledge_conflict_interactions (
  id TEXT PRIMARY KEY CHECK (char_length(id) BETWEEN 1 AND 512),
  candidate_id TEXT NOT NULL REFERENCES knowledge_conflict_candidates(id) ON DELETE RESTRICT,
  callback_operation_key TEXT NOT NULL UNIQUE CHECK (
    char_length(callback_operation_key) BETWEEN 1 AND 512
  ),
  actor_ref TEXT NOT NULL CHECK (char_length(actor_ref) BETWEEN 1 AND 512),
  action TEXT NOT NULL CHECK (action IN ('dismiss', 'approve_for_delivery', 'create_draft')),
  result TEXT NOT NULL CHECK (result IN ('applied', 'already_applied', 'rejected')),
  draft_id TEXT REFERENCES knowledge_drafts(id) ON DELETE RESTRICT,
  reason_code TEXT CHECK (reason_code IS NULL OR char_length(reason_code) BETWEEN 1 AND 128),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK ((action = 'create_draft' AND result = 'applied') = (draft_id IS NOT NULL))
);

CREATE INDEX knowledge_conflict_interactions_candidate_idx
  ON knowledge_conflict_interactions (candidate_id, created_at, id);

CREATE TABLE answer_reply_knowledge_conflicts (
  delivery_id TEXT PRIMARY KEY REFERENCES answer_reply_deliveries(id) ON DELETE RESTRICT,
  candidate_id TEXT NOT NULL REFERENCES knowledge_conflict_candidates(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX answer_reply_knowledge_conflicts_candidate_idx
  ON answer_reply_knowledge_conflicts (candidate_id, created_at, delivery_id);

ALTER TABLE answer_reply_deliveries
  ADD COLUMN knowledge_conflict_candidate_id TEXT CHECK (
    knowledge_conflict_candidate_id IS NULL
    OR char_length(knowledge_conflict_candidate_id) BETWEEN 1 AND 512
  );

ALTER TABLE answer_reply_deliveries
  ADD CONSTRAINT answer_reply_deliveries_knowledge_conflict_candidate_fkey
  FOREIGN KEY (knowledge_conflict_candidate_id)
  REFERENCES knowledge_conflict_candidates(id) ON DELETE RESTRICT;

ALTER TABLE knowledge_draft_revision_evidence
  DROP CONSTRAINT knowledge_draft_revision_evidence_evidence_type_check;

ALTER TABLE knowledge_draft_revision_evidence
  ADD CONSTRAINT knowledge_draft_revision_evidence_evidence_type_check CHECK (
    evidence_type IN (
      'conversation_message', 'discussion_thread', 'action_item',
      'group_memory', 'document_source'
    )
  );

ALTER TABLE knowledge_draft_revision_evidence
  DROP CONSTRAINT knowledge_draft_revision_evidence_check;

ALTER TABLE knowledge_draft_revision_evidence
  ADD CONSTRAINT knowledge_draft_revision_evidence_shape_check CHECK (
    (evidence_type = 'conversation_message'
      AND source_group_id IS NOT NULL AND entity_version IS NULL AND source_updated_at IS NULL)
    OR (evidence_type IN ('discussion_thread', 'action_item')
      AND source_group_id IS NOT NULL AND entity_version IS NOT NULL AND source_updated_at IS NULL)
    OR (evidence_type = 'group_memory'
      AND source_group_id IS NOT NULL AND entity_version IS NULL AND source_updated_at IS NOT NULL)
    OR (evidence_type = 'document_source'
      AND source_group_id IS NULL AND entity_version IS NULL AND source_updated_at IS NOT NULL)
  );

CREATE TRIGGER knowledge_conflict_evidence_append_only
BEFORE UPDATE OR DELETE ON knowledge_conflict_evidence
FOR EACH ROW EXECUTE FUNCTION knowledge_draft_append_only_guard();

CREATE TRIGGER knowledge_conflict_evidence_truncate_guard
BEFORE TRUNCATE ON knowledge_conflict_evidence
FOR EACH STATEMENT EXECUTE FUNCTION knowledge_draft_append_only_guard();

CREATE TRIGGER knowledge_conflict_candidate_events_append_only
BEFORE UPDATE OR DELETE ON knowledge_conflict_candidate_events
FOR EACH ROW EXECUTE FUNCTION knowledge_draft_append_only_guard();

CREATE TRIGGER knowledge_conflict_candidate_events_truncate_guard
BEFORE TRUNCATE ON knowledge_conflict_candidate_events
FOR EACH STATEMENT EXECUTE FUNCTION knowledge_draft_append_only_guard();

CREATE TRIGGER knowledge_conflict_interactions_append_only
BEFORE UPDATE OR DELETE ON knowledge_conflict_interactions
FOR EACH ROW EXECUTE FUNCTION knowledge_draft_append_only_guard();

CREATE TRIGGER knowledge_conflict_interactions_truncate_guard
BEFORE TRUNCATE ON knowledge_conflict_interactions
FOR EACH STATEMENT EXECUTE FUNCTION knowledge_draft_append_only_guard();

CREATE TRIGGER knowledge_conflict_delivery_reconciliations_append_only
BEFORE UPDATE OR DELETE ON knowledge_conflict_delivery_reconciliations
FOR EACH ROW EXECUTE FUNCTION knowledge_draft_append_only_guard();

CREATE TRIGGER knowledge_conflict_delivery_reconciliations_truncate_guard
BEFORE TRUNCATE ON knowledge_conflict_delivery_reconciliations
FOR EACH STATEMENT EXECUTE FUNCTION knowledge_draft_append_only_guard();

CREATE TRIGGER knowledge_conflict_scan_operations_append_only
BEFORE UPDATE OR DELETE ON knowledge_conflict_scan_operations
FOR EACH ROW EXECUTE FUNCTION knowledge_draft_append_only_guard();

CREATE TRIGGER knowledge_conflict_scan_operations_truncate_guard
BEFORE TRUNCATE ON knowledge_conflict_scan_operations
FOR EACH STATEMENT EXECUTE FUNCTION knowledge_draft_append_only_guard();

CREATE TRIGGER answer_reply_knowledge_conflicts_append_only
BEFORE UPDATE OR DELETE ON answer_reply_knowledge_conflicts
FOR EACH ROW EXECUTE FUNCTION knowledge_draft_append_only_guard();

CREATE TRIGGER answer_reply_knowledge_conflicts_truncate_guard
BEFORE TRUNCATE ON answer_reply_knowledge_conflicts
FOR EACH STATEMENT EXECUTE FUNCTION knowledge_draft_append_only_guard();
