CREATE TABLE proactive_signal_delivery_outbox (
  id TEXT PRIMARY KEY CHECK (char_length(id) BETWEEN 1 AND 512),
  candidate_idempotency_key TEXT NOT NULL
    REFERENCES proactive_signal_candidates(idempotency_key) ON DELETE RESTRICT,
  group_id TEXT NOT NULL CHECK (char_length(group_id) BETWEEN 1 AND 512),
  delivery_channel TEXT NOT NULL CHECK (delivery_channel IN ('feishu_group_card')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'sent', 'failed', 'cancelled')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  failure_classification TEXT CHECK (
    failure_classification IS NULL OR char_length(failure_classification) BETWEEN 1 AND 128
  ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (candidate_idempotency_key, delivery_channel)
);

CREATE TABLE proactive_signal_delivery_events (
  id TEXT PRIMARY KEY CHECK (char_length(id) BETWEEN 1 AND 512),
  delivery_id TEXT NOT NULL REFERENCES proactive_signal_delivery_outbox(id) ON DELETE CASCADE,
  candidate_idempotency_key TEXT NOT NULL,
  group_id TEXT NOT NULL CHECK (char_length(group_id) BETWEEN 1 AND 512),
  event_type TEXT NOT NULL CHECK (
    event_type IN ('queued', 'processing', 'sent', 'failed', 'cancelled')
  ),
  delivery_status TEXT NOT NULL CHECK (
    delivery_status IN ('pending', 'processing', 'sent', 'failed', 'cancelled')
  ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX proactive_signal_delivery_outbox_status_idx
  ON proactive_signal_delivery_outbox (status, next_attempt_at, created_at);

CREATE INDEX proactive_signal_delivery_events_delivery_idx
  ON proactive_signal_delivery_events (delivery_id, created_at);

CREATE TRIGGER proactive_signal_delivery_events_append_only
BEFORE UPDATE OR DELETE ON proactive_signal_delivery_events
FOR EACH ROW EXECUTE FUNCTION conversation_state_event_append_only_guard();

CREATE TRIGGER proactive_signal_delivery_events_truncate_guard
BEFORE TRUNCATE ON proactive_signal_delivery_events
FOR EACH STATEMENT EXECUTE FUNCTION conversation_state_event_append_only_guard();
