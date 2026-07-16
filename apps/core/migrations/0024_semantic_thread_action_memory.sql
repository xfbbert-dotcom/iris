ALTER TABLE conversation_messages
ADD CONSTRAINT conversation_messages_id_chat_id_key UNIQUE (id, chat_id);

ALTER TABLE group_memories
ADD CONSTRAINT group_memories_id_group_id_key UNIQUE (id, group_id);

CREATE TABLE discussion_threads (
  id TEXT PRIMARY KEY CHECK (char_length(id) BETWEEN 1 AND 512),
  group_id TEXT NOT NULL CHECK (char_length(group_id) BETWEEN 1 AND 512),
  title TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 512),
  summary TEXT NOT NULL CHECK (char_length(summary) BETWEEN 1 AND 4000),
  status TEXT NOT NULL CHECK (status IN ('candidate', 'open', 'resolved', 'merged')),
  confidence DOUBLE PRECISION NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  merged_into_thread_id TEXT,
  version BIGINT NOT NULL DEFAULT 1 CHECK (version >= 1),
  first_evidence_at TIMESTAMPTZ NOT NULL,
  last_activity_at TIMESTAMPTZ NOT NULL,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (id, group_id),
  FOREIGN KEY (merged_into_thread_id, group_id)
    REFERENCES discussion_threads(id, group_id) ON DELETE RESTRICT,
  CHECK ((status = 'merged') = (merged_into_thread_id IS NOT NULL)),
  CHECK ((status = 'resolved') = (resolved_at IS NOT NULL)),
  CHECK (merged_into_thread_id IS NULL OR merged_into_thread_id <> id)
);

CREATE TABLE discussion_thread_evidence (
  thread_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  conversation_message_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (thread_id, conversation_message_id),
  FOREIGN KEY (thread_id, group_id)
    REFERENCES discussion_threads(id, group_id) ON DELETE CASCADE,
  FOREIGN KEY (conversation_message_id, group_id)
    REFERENCES conversation_messages(id, chat_id) ON DELETE RESTRICT
);

CREATE TABLE discussion_thread_events (
  id TEXT PRIMARY KEY CHECK (char_length(id) BETWEEN 1 AND 512),
  thread_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'created', 'promoted', 'summary_updated', 'resolved', 'reopened',
    'merged', 'corrected'
  )),
  from_version BIGINT CHECK (from_version IS NULL OR from_version >= 1),
  to_version BIGINT NOT NULL CHECK (to_version >= 1),
  operation_key TEXT NOT NULL CHECK (char_length(operation_key) BETWEEN 1 AND 512),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (id, group_id),
  UNIQUE (group_id, operation_key),
  FOREIGN KEY (thread_id, group_id)
    REFERENCES discussion_threads(id, group_id) ON DELETE CASCADE
);

CREATE TABLE discussion_thread_event_evidence (
  event_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  conversation_message_id TEXT NOT NULL,
  PRIMARY KEY (event_id, conversation_message_id),
  FOREIGN KEY (event_id, group_id)
    REFERENCES discussion_thread_events(id, group_id) ON DELETE CASCADE,
  FOREIGN KEY (conversation_message_id, group_id)
    REFERENCES conversation_messages(id, chat_id) ON DELETE RESTRICT
);

CREATE TABLE action_items (
  id TEXT PRIMARY KEY CHECK (char_length(id) BETWEEN 1 AND 512),
  group_id TEXT NOT NULL CHECK (char_length(group_id) BETWEEN 1 AND 512),
  thread_id TEXT,
  description TEXT NOT NULL CHECK (char_length(description) BETWEEN 1 AND 4000),
  owner_ref_type TEXT NOT NULL CHECK (owner_ref_type IN ('feishu_user', 'text_label')),
  owner_ref TEXT NOT NULL CHECK (char_length(owner_ref) BETWEEN 1 AND 512),
  due_at TIMESTAMPTZ,
  status TEXT NOT NULL CHECK (status IN ('open', 'completed', 'cancelled')),
  confidence DOUBLE PRECISION NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  version BIGINT NOT NULL DEFAULT 1 CHECK (version >= 1),
  completed_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (id, group_id),
  FOREIGN KEY (thread_id, group_id)
    REFERENCES discussion_threads(id, group_id) ON DELETE RESTRICT,
  CHECK ((status = 'completed') = (completed_at IS NOT NULL)),
  CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL))
);

CREATE TABLE action_item_events (
  id TEXT PRIMARY KEY CHECK (char_length(id) BETWEEN 1 AND 512),
  action_item_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'created', 'completed', 'cancelled', 'reopened', 'owner_resolved', 'corrected'
  )),
  from_version BIGINT CHECK (from_version IS NULL OR from_version >= 1),
  to_version BIGINT NOT NULL CHECK (to_version >= 1),
  operation_key TEXT NOT NULL CHECK (char_length(operation_key) BETWEEN 1 AND 512),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (id, group_id),
  UNIQUE (group_id, operation_key),
  FOREIGN KEY (action_item_id, group_id)
    REFERENCES action_items(id, group_id) ON DELETE CASCADE
);

CREATE TABLE action_item_event_evidence (
  event_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  conversation_message_id TEXT NOT NULL,
  PRIMARY KEY (event_id, conversation_message_id),
  FOREIGN KEY (event_id, group_id)
    REFERENCES action_item_events(id, group_id) ON DELETE CASCADE,
  FOREIGN KEY (conversation_message_id, group_id)
    REFERENCES conversation_messages(id, chat_id) ON DELETE RESTRICT
);

CREATE TABLE conversation_state_operation_claims (
  group_id TEXT NOT NULL CHECK (char_length(group_id) BETWEEN 1 AND 512),
  operation_key TEXT NOT NULL CHECK (char_length(operation_key) BETWEEN 1 AND 512),
  entity_type TEXT NOT NULL CHECK (entity_type IN ('thread', 'action')),
  entity_id TEXT NOT NULL CHECK (char_length(entity_id) BETWEEN 1 AND 512),
  operation_fingerprint TEXT NOT NULL CHECK (operation_fingerprint ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (group_id, operation_key)
);

CREATE TABLE conversation_state_memory_projections (
  entity_type TEXT NOT NULL CHECK (entity_type IN ('thread', 'action')),
  entity_id TEXT NOT NULL CHECK (char_length(entity_id) BETWEEN 1 AND 512),
  group_id TEXT NOT NULL CHECK (char_length(group_id) BETWEEN 1 AND 512),
  projected_version BIGINT NOT NULL CHECK (projected_version >= 1),
  memory_id TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (entity_type, entity_id),
  FOREIGN KEY (memory_id, group_id)
    REFERENCES group_memories(id, group_id) ON DELETE SET NULL (memory_id)
);

CREATE TABLE conversation_state_projection_repairs (
  id TEXT PRIMARY KEY CHECK (char_length(id) BETWEEN 1 AND 512),
  entity_type TEXT NOT NULL CHECK (entity_type IN ('thread', 'action')),
  entity_id TEXT NOT NULL CHECK (char_length(entity_id) BETWEEN 1 AND 512),
  group_id TEXT NOT NULL CHECK (char_length(group_id) BETWEEN 1 AND 512),
  entity_version BIGINT NOT NULL CHECK (entity_version >= 1),
  status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  failure_classification TEXT CHECK (
    failure_classification IS NULL OR char_length(failure_classification) BETWEEN 1 AND 128
  ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (entity_type, entity_id, entity_version)
);

CREATE INDEX discussion_threads_group_status_last_activity_idx
  ON discussion_threads (group_id, status, last_activity_at DESC);

CREATE INDEX action_items_group_status_updated_idx
  ON action_items (group_id, status, updated_at DESC);

CREATE INDEX discussion_thread_evidence_message_id_idx
  ON discussion_thread_evidence (conversation_message_id, thread_id);

CREATE INDEX discussion_thread_event_evidence_message_id_idx
  ON discussion_thread_event_evidence (conversation_message_id, event_id);

CREATE INDEX action_item_event_evidence_message_id_idx
  ON action_item_event_evidence (conversation_message_id, event_id);

CREATE INDEX conversation_state_projection_repairs_pending_idx
  ON conversation_state_projection_repairs (next_attempt_at, created_at)
  WHERE status = 'pending';

CREATE OR REPLACE FUNCTION conversation_state_event_append_only_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'conversation state event records are append-only';
  RETURN NULL;
END;
$$;

CREATE TRIGGER discussion_thread_events_append_only
BEFORE UPDATE OR DELETE ON discussion_thread_events
FOR EACH ROW EXECUTE FUNCTION conversation_state_event_append_only_guard();

CREATE TRIGGER discussion_thread_event_evidence_append_only
BEFORE UPDATE OR DELETE ON discussion_thread_event_evidence
FOR EACH ROW EXECUTE FUNCTION conversation_state_event_append_only_guard();

CREATE TRIGGER action_item_events_append_only
BEFORE UPDATE OR DELETE ON action_item_events
FOR EACH ROW EXECUTE FUNCTION conversation_state_event_append_only_guard();

CREATE TRIGGER action_item_event_evidence_append_only
BEFORE UPDATE OR DELETE ON action_item_event_evidence
FOR EACH ROW EXECUTE FUNCTION conversation_state_event_append_only_guard();

CREATE TRIGGER conversation_state_operation_claims_append_only
BEFORE UPDATE OR DELETE ON conversation_state_operation_claims
FOR EACH ROW EXECUTE FUNCTION conversation_state_event_append_only_guard();

CREATE TRIGGER discussion_thread_events_truncate_guard
BEFORE TRUNCATE ON discussion_thread_events
FOR EACH STATEMENT EXECUTE FUNCTION conversation_state_event_append_only_guard();

CREATE TRIGGER discussion_thread_event_evidence_truncate_guard
BEFORE TRUNCATE ON discussion_thread_event_evidence
FOR EACH STATEMENT EXECUTE FUNCTION conversation_state_event_append_only_guard();

CREATE TRIGGER action_item_events_truncate_guard
BEFORE TRUNCATE ON action_item_events
FOR EACH STATEMENT EXECUTE FUNCTION conversation_state_event_append_only_guard();

CREATE TRIGGER action_item_event_evidence_truncate_guard
BEFORE TRUNCATE ON action_item_event_evidence
FOR EACH STATEMENT EXECUTE FUNCTION conversation_state_event_append_only_guard();

CREATE TRIGGER conversation_state_operation_claims_truncate_guard
BEFORE TRUNCATE ON conversation_state_operation_claims
FOR EACH STATEMENT EXECUTE FUNCTION conversation_state_event_append_only_guard();
