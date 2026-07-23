CREATE TABLE proactive_signal_candidates (
  idempotency_key TEXT PRIMARY KEY CHECK (char_length(idempotency_key) BETWEEN 1 AND 512),
  group_id TEXT NOT NULL CHECK (char_length(group_id) BETWEEN 1 AND 512),
  kind TEXT NOT NULL CHECK (kind IN ('quiet_open_thread', 'overdue_action')),
  priority TEXT NOT NULL CHECK (priority IN ('medium', 'high')),
  entity_type TEXT NOT NULL CHECK (entity_type IN ('thread', 'action')),
  entity_id TEXT NOT NULL CHECK (char_length(entity_id) BETWEEN 1 AND 512),
  entity_version BIGINT NOT NULL CHECK (entity_version >= 1),
  reason_code TEXT NOT NULL CHECK (
    reason_code IN ('thread_quiet_threshold_elapsed', 'action_due_at_elapsed')
  ),
  suggested_mode TEXT NOT NULL CHECK (
    suggested_mode IN ('ask_for_thread_update', 'ask_for_status')
  ),
  status TEXT NOT NULL CHECK (status IN ('pending', 'dismissed', 'superseded')),
  last_relevant_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (group_id, kind, entity_id, entity_version)
);

CREATE TABLE proactive_signal_candidate_evidence (
  idempotency_key TEXT NOT NULL REFERENCES proactive_signal_candidates(idempotency_key) ON DELETE CASCADE,
  conversation_message_id TEXT NOT NULL,
  group_id TEXT NOT NULL CHECK (char_length(group_id) BETWEEN 1 AND 512),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (idempotency_key, conversation_message_id),
  FOREIGN KEY (conversation_message_id, group_id)
    REFERENCES conversation_messages(id, chat_id) ON DELETE RESTRICT
);

CREATE TABLE proactive_signal_candidate_events (
  id TEXT PRIMARY KEY CHECK (char_length(id) BETWEEN 1 AND 512),
  idempotency_key TEXT NOT NULL REFERENCES proactive_signal_candidates(idempotency_key) ON DELETE CASCADE,
  group_id TEXT NOT NULL CHECK (char_length(group_id) BETWEEN 1 AND 512),
  event_type TEXT NOT NULL CHECK (event_type IN ('created', 'dismissed', 'superseded')),
  candidate_status TEXT NOT NULL CHECK (candidate_status IN ('pending', 'dismissed', 'superseded')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX proactive_signal_candidates_group_status_idx
  ON proactive_signal_candidates (group_id, status, priority, last_relevant_at);

CREATE INDEX proactive_signal_candidate_events_key_idx
  ON proactive_signal_candidate_events (idempotency_key, created_at);

CREATE TRIGGER proactive_signal_candidate_events_append_only
BEFORE UPDATE OR DELETE ON proactive_signal_candidate_events
FOR EACH ROW EXECUTE FUNCTION conversation_state_event_append_only_guard();

CREATE TRIGGER proactive_signal_candidate_events_truncate_guard
BEFORE TRUNCATE ON proactive_signal_candidate_events
FOR EACH STATEMENT EXECUTE FUNCTION conversation_state_event_append_only_guard();
