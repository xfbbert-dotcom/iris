CREATE FUNCTION answer_reply_document_source_ids_valid(
  document_source_ids TEXT[],
  source_count INTEGER
)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
DECLARE
  document_source_id TEXT;
  seen_document_source_ids TEXT[] := ARRAY[]::TEXT[];
BEGIN
  IF COALESCE(array_ndims(document_source_ids), 1) <> 1
    OR cardinality(document_source_ids) > 1000
    OR cardinality(document_source_ids) > source_count THEN
    RETURN FALSE;
  END IF;

  FOREACH document_source_id IN ARRAY document_source_ids LOOP
    IF document_source_id IS NULL
      OR document_source_id !~ '[^[:space:]]'
      OR document_source_id ~ '^[[:space:]]|[[:space:]]$'
      OR char_length(document_source_id) NOT BETWEEN 1 AND 512
      OR document_source_id = ANY(seen_document_source_ids) THEN
      RETURN FALSE;
    END IF;
    seen_document_source_ids := array_append(seen_document_source_ids, document_source_id);
  END LOOP;

  RETURN TRUE;
END;
$$;

CREATE TABLE answer_reply_deliveries (
  id TEXT PRIMARY KEY CHECK (char_length(id) BETWEEN 1 AND 512),
  provider TEXT NOT NULL CHECK (
    char_length(provider) BETWEEN 1 AND 512
    AND provider IN ('feishu')
  ),
  incoming_message_id TEXT NOT NULL CHECK (char_length(incoming_message_id) BETWEEN 1 AND 512),
  chat_id TEXT NOT NULL CHECK (char_length(chat_id) BETWEEN 1 AND 512),
  reply_uuid TEXT NOT NULL CHECK (char_length(reply_uuid) BETWEEN 1 AND 50),
  safe_notice_uuid TEXT NOT NULL CHECK (char_length(safe_notice_uuid) BETWEEN 1 AND 50),
  state TEXT NOT NULL CHECK (state IN (
    'prepared', 'sending', 'sent',
    'permission_blocked', 'reconciliation_required'
  )),
  prepared_reply_text TEXT CHECK (
    prepared_reply_text IS NULL
    OR char_length(prepared_reply_text) BETWEEN 1 AND 8000
  ),
  rendered_reply_fingerprint TEXT NOT NULL CHECK (
    rendered_reply_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  semantic_fingerprint TEXT NOT NULL CHECK (
    semantic_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  reply_message_id TEXT CHECK (
    reply_message_id IS NULL OR char_length(reply_message_id) BETWEEN 1 AND 512
  ),
  safe_notice_message_id TEXT CHECK (
    safe_notice_message_id IS NULL OR char_length(safe_notice_message_id) BETWEEN 1 AND 512
  ),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  safe_notice_attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (safe_notice_attempt_count >= 0),
  version BIGINT NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  last_send_started_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  permission_blocked_at TIMESTAMPTZ,
  reconciliation_required_at TIMESTAMPTZ,
  safe_notice_sent_at TIMESTAMPTZ,
  UNIQUE (provider, incoming_message_id),
  CHECK (
    (state IN ('prepared', 'sending') AND prepared_reply_text IS NOT NULL)
    OR (state IN ('sent', 'permission_blocked', 'reconciliation_required')
      AND prepared_reply_text IS NULL)
  ),
  CHECK (state <> 'permission_blocked' OR attempt_count = 0),
  CHECK (state <> 'reconciliation_required' OR attempt_count > 0),
  CHECK (state <> 'sent' OR sent_at IS NOT NULL),
  CHECK (state <> 'permission_blocked' OR permission_blocked_at IS NOT NULL),
  CHECK (
    state <> 'reconciliation_required' OR reconciliation_required_at IS NOT NULL
  ),
  CHECK (safe_notice_sent_at IS NULL OR safe_notice_attempt_count > 0),
  CHECK (safe_notice_message_id IS NULL OR safe_notice_sent_at IS NOT NULL)
);

CREATE INDEX answer_reply_deliveries_provider_incoming_idx
  ON answer_reply_deliveries (provider, incoming_message_id);

CREATE TABLE answer_reply_source_traces (
  id TEXT PRIMARY KEY CHECK (char_length(id) BETWEEN 1 AND 512),
  delivery_id TEXT NOT NULL REFERENCES answer_reply_deliveries(id) ON DELETE RESTRICT
    CHECK (char_length(delivery_id) BETWEEN 1 AND 512),
  prompt_rank INTEGER NOT NULL CHECK (prompt_rank > 0),
  citation_rank INTEGER CHECK (citation_rank IS NULL OR citation_rank BETWEEN 1 AND 3),
  document_source_id TEXT NOT NULL CHECK (char_length(document_source_id) BETWEEN 1 AND 512),
  document_snapshot_id TEXT NOT NULL CHECK (char_length(document_snapshot_id) BETWEEN 1 AND 512),
  fragment_id TEXT NOT NULL CHECK (char_length(fragment_id) BETWEEN 1 AND 512),
  chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
  source_type TEXT NOT NULL CHECK (source_type IN (
    'feishu_wiki', 'feishu_group_document', 'manual_upload'
  )),
  source_uri TEXT NOT NULL CHECK (char_length(source_uri) BETWEEN 1 AND 2048),
  source_title TEXT CHECK (
    source_title IS NULL OR char_length(source_title) BETWEEN 1 AND 512
  ),
  content_hash TEXT NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  embedding_profile_id TEXT NOT NULL CHECK (char_length(embedding_profile_id) BETWEEN 1 AND 512),
  initial_permission_checked_at TIMESTAMPTZ NOT NULL,
  UNIQUE (delivery_id, prompt_rank)
);

CREATE INDEX answer_reply_source_traces_delivery_prompt_idx
  ON answer_reply_source_traces (delivery_id, prompt_rank);

CREATE TABLE answer_reply_delivery_events (
  id TEXT PRIMARY KEY CHECK (char_length(id) BETWEEN 1 AND 512),
  delivery_id TEXT NOT NULL REFERENCES answer_reply_deliveries(id) ON DELETE RESTRICT
    CHECK (char_length(delivery_id) BETWEEN 1 AND 512),
  sequence BIGINT NOT NULL CHECK (sequence > 0),
  event_type TEXT NOT NULL CHECK (event_type IN (
    'prepared', 'send_started', 'sent',
    'permission_blocked', 'reconciliation_required',
    'safe_notice_send_started', 'safe_notice_sent'
  )),
  attempt_number INTEGER CHECK (attempt_number IS NULL OR attempt_number > 0),
  source_count INTEGER NOT NULL CHECK (source_count BETWEEN 0 AND 1000),
  document_source_ids TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (delivery_id, sequence),
  CONSTRAINT answer_reply_delivery_events_document_source_ids_check CHECK (
    answer_reply_document_source_ids_valid(document_source_ids, source_count)
  ),
  CHECK (
    (event_type IN ('send_started', 'safe_notice_send_started') AND attempt_number IS NOT NULL)
    OR (event_type NOT IN ('send_started', 'safe_notice_send_started') AND attempt_number IS NULL)
  )
);

CREATE INDEX answer_reply_delivery_events_delivery_sequence_idx
  ON answer_reply_delivery_events (delivery_id, sequence);

CREATE TRIGGER answer_reply_source_traces_append_only
BEFORE UPDATE OR DELETE ON answer_reply_source_traces
FOR EACH ROW EXECUTE FUNCTION knowledge_draft_append_only_guard();

CREATE TRIGGER answer_reply_source_traces_truncate_guard
BEFORE TRUNCATE ON answer_reply_source_traces
FOR EACH STATEMENT EXECUTE FUNCTION knowledge_draft_append_only_guard();

CREATE TRIGGER answer_reply_delivery_events_append_only
BEFORE UPDATE OR DELETE ON answer_reply_delivery_events
FOR EACH ROW EXECUTE FUNCTION knowledge_draft_append_only_guard();

CREATE TRIGGER answer_reply_delivery_events_truncate_guard
BEFORE TRUNCATE ON answer_reply_delivery_events
FOR EACH STATEMENT EXECUTE FUNCTION knowledge_draft_append_only_guard();
