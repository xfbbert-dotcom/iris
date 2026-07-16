ALTER TABLE discussion_thread_events
  DROP CONSTRAINT discussion_thread_events_event_type_check,
  ADD CONSTRAINT discussion_thread_events_event_type_check CHECK (event_type IN (
    'created', 'promoted', 'summary_updated', 'resolved', 'reopened',
    'merged', 'corrected', 'evidence_attached'
  ));

CREATE TABLE group_memory_extraction_run_threads (
  run_id TEXT NOT NULL REFERENCES group_memory_extraction_runs(id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL REFERENCES discussion_threads(id) ON DELETE RESTRICT,
  ordinal SMALLINT NOT NULL CHECK (ordinal BETWEEN 0 AND 11),
  thread_version BIGINT NOT NULL CHECK (thread_version >= 1),
  thread_updated_at TIMESTAMPTZ NOT NULL,
  thread_evidence_count BIGINT NOT NULL CHECK (thread_evidence_count >= 0),
  PRIMARY KEY (run_id, thread_id),
  UNIQUE (run_id, ordinal)
);

CREATE TABLE group_memory_extraction_run_actions (
  run_id TEXT NOT NULL REFERENCES group_memory_extraction_runs(id) ON DELETE CASCADE,
  action_item_id TEXT NOT NULL REFERENCES action_items(id) ON DELETE RESTRICT,
  ordinal SMALLINT NOT NULL CHECK (ordinal BETWEEN 0 AND 11),
  action_version BIGINT NOT NULL CHECK (action_version >= 1),
  action_updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (run_id, action_item_id),
  UNIQUE (run_id, ordinal)
);

CREATE TABLE group_memory_extraction_run_mentions (
  run_id TEXT NOT NULL REFERENCES group_memory_extraction_runs(id) ON DELETE CASCADE,
  conversation_message_id TEXT NOT NULL REFERENCES conversation_messages(id) ON DELETE RESTRICT,
  mention_key TEXT NOT NULL CHECK (char_length(mention_key) BETWEEN 1 AND 512),
  mentioned_open_id TEXT NOT NULL CHECK (char_length(mentioned_open_id) BETWEEN 1 AND 512),
  PRIMARY KEY (run_id, conversation_message_id, mention_key),
  UNIQUE (run_id, conversation_message_id, mentioned_open_id)
);

ALTER TABLE group_memory_extraction_runs
  ADD COLUMN thread_operation_count SMALLINT NOT NULL DEFAULT 0
    CHECK (thread_operation_count BETWEEN 0 AND 8),
  ADD COLUMN action_operation_count SMALLINT NOT NULL DEFAULT 0
    CHECK (action_operation_count BETWEEN 0 AND 8),
  ADD COLUMN conversation_state_rejected_count SMALLINT NOT NULL DEFAULT 0
    CHECK (conversation_state_rejected_count BETWEEN 0 AND 16),
  ADD COLUMN conversation_state_rejection_codes TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
