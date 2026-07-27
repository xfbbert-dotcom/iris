CREATE TABLE proactive_signal_feedback_events (
  idempotency_key TEXT PRIMARY KEY CHECK (char_length(idempotency_key) BETWEEN 1 AND 512),
  delivery_id TEXT NOT NULL REFERENCES proactive_signal_delivery_outbox(id) ON DELETE RESTRICT,
  candidate_idempotency_key TEXT NOT NULL
    REFERENCES proactive_signal_candidates(idempotency_key) ON DELETE RESTRICT,
  group_id TEXT NOT NULL CHECK (char_length(group_id) BETWEEN 1 AND 512),
  message_id TEXT CHECK (message_id IS NULL OR char_length(message_id) BETWEEN 1 AND 512),
  entity_version BIGINT NOT NULL CHECK (entity_version >= 1),
  actor_fingerprint TEXT NOT NULL CHECK (actor_fingerprint ~ '^[0-9a-f]{64}$'),
  feedback TEXT NOT NULL CHECK (feedback IN ('helpful', 'irrelevant')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (delivery_id, actor_fingerprint)
);

CREATE TABLE proactive_signal_suppressions (
  group_id TEXT NOT NULL CHECK (char_length(group_id) BETWEEN 1 AND 512),
  kind TEXT NOT NULL CHECK (kind IN ('quiet_open_thread', 'overdue_action')),
  entity_id TEXT NOT NULL CHECK (char_length(entity_id) BETWEEN 1 AND 512),
  suppress_until TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (group_id, kind, entity_id)
);

CREATE INDEX proactive_signal_feedback_events_group_time_idx
  ON proactive_signal_feedback_events (group_id, created_at);

CREATE INDEX proactive_signal_suppressions_group_until_idx
  ON proactive_signal_suppressions (group_id, suppress_until);

CREATE TRIGGER proactive_signal_feedback_events_append_only
BEFORE UPDATE OR DELETE ON proactive_signal_feedback_events
FOR EACH ROW EXECUTE FUNCTION conversation_state_event_append_only_guard();

CREATE TRIGGER proactive_signal_feedback_events_truncate_guard
BEFORE TRUNCATE ON proactive_signal_feedback_events
FOR EACH STATEMENT EXECUTE FUNCTION conversation_state_event_append_only_guard();
