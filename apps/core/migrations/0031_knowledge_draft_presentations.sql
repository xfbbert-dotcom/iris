CREATE TABLE knowledge_draft_presentations (
  id TEXT PRIMARY KEY CHECK (char_length(id) BETWEEN 1 AND 512),
  draft_id TEXT NOT NULL,
  revision_number INTEGER NOT NULL CHECK (revision_number >= 1),
  draft_version BIGINT NOT NULL CHECK (draft_version >= 1),
  chat_id TEXT NOT NULL CHECK (char_length(chat_id) BETWEEN 1 AND 512),
  content_hash TEXT NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
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
  FOREIGN KEY (draft_id, revision_number)
    REFERENCES knowledge_draft_revisions(draft_id, revision_number) ON DELETE RESTRICT,
  UNIQUE (id, draft_id, revision_number),
  CHECK (
    (state = 'active' AND message_id IS NOT NULL AND activated_at IS NOT NULL AND closed_at IS NULL)
    OR (state = 'closed' AND closed_at IS NOT NULL)
    OR (state IN ('pending_send', 'superseded', 'send_failed') AND closed_at IS NULL)
  )
);

CREATE UNIQUE INDEX knowledge_draft_presentations_one_active_idx
  ON knowledge_draft_presentations (draft_id, revision_number, chat_id)
  WHERE state = 'active';

CREATE INDEX knowledge_draft_presentations_draft_created_idx
  ON knowledge_draft_presentations (draft_id, created_at DESC, id ASC);

CREATE TABLE knowledge_draft_presentation_events (
  id TEXT PRIMARY KEY CHECK (char_length(id) BETWEEN 1 AND 512),
  presentation_id TEXT NOT NULL REFERENCES knowledge_draft_presentations(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'created', 'send_succeeded', 'send_failed', 'confirmed', 'revision_requested',
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

CREATE INDEX knowledge_draft_presentation_events_presentation_created_idx
  ON knowledge_draft_presentation_events (presentation_id, created_at ASC, id ASC);

CREATE TABLE knowledge_draft_group_confirmations (
  draft_id TEXT NOT NULL,
  revision_number INTEGER NOT NULL,
  presentation_id TEXT NOT NULL,
  actor_open_id TEXT NOT NULL CHECK (char_length(actor_open_id) BETWEEN 1 AND 512),
  callback_event_id TEXT NOT NULL UNIQUE CHECK (char_length(callback_event_id) BETWEEN 1 AND 512),
  membership_checked_at TIMESTAMPTZ NOT NULL,
  confirmed_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (draft_id, revision_number),
  FOREIGN KEY (draft_id, revision_number)
    REFERENCES knowledge_draft_revisions(draft_id, revision_number) ON DELETE RESTRICT,
  FOREIGN KEY (presentation_id, draft_id, revision_number)
    REFERENCES knowledge_draft_presentations (id, draft_id, revision_number) ON DELETE RESTRICT
);

CREATE TABLE knowledge_draft_presentation_outbox (
  id TEXT PRIMARY KEY CHECK (char_length(id) BETWEEN 1 AND 512),
  presentation_id TEXT NOT NULL UNIQUE
    REFERENCES knowledge_draft_presentations(id) ON DELETE RESTRICT,
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

CREATE INDEX knowledge_draft_presentation_outbox_ready_idx
  ON knowledge_draft_presentation_outbox (state, retry_at ASC, created_at ASC, id ASC);

ALTER TABLE knowledge_draft_events
  DROP CONSTRAINT knowledge_draft_events_event_type_check;

ALTER TABLE knowledge_draft_events
  ADD CONSTRAINT knowledge_draft_events_event_type_check CHECK (event_type IN (
    'created', 'revised', 'group_confirmed', 'revision_requested', 'rejected'
  ));

CREATE TRIGGER knowledge_draft_presentation_events_append_only
BEFORE UPDATE OR DELETE ON knowledge_draft_presentation_events
FOR EACH ROW EXECUTE FUNCTION knowledge_draft_append_only_guard();

CREATE TRIGGER knowledge_draft_presentation_events_truncate_guard
BEFORE TRUNCATE ON knowledge_draft_presentation_events
FOR EACH STATEMENT EXECUTE FUNCTION knowledge_draft_append_only_guard();

CREATE TRIGGER knowledge_draft_group_confirmations_append_only
BEFORE UPDATE OR DELETE ON knowledge_draft_group_confirmations
FOR EACH ROW EXECUTE FUNCTION knowledge_draft_append_only_guard();

CREATE TRIGGER knowledge_draft_group_confirmations_truncate_guard
BEFORE TRUNCATE ON knowledge_draft_group_confirmations
FOR EACH STATEMENT EXECUTE FUNCTION knowledge_draft_append_only_guard();
