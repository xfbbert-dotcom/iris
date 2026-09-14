-- Independent, initially empty domain. No runtime capability or policy is enabled.
CREATE TABLE proactive_discussion_policies (
  chat_id text PRIMARY KEY CHECK (char_length(chat_id) BETWEEN 1 AND 512 AND chat_id = btrim(chat_id)),
  version bigint NOT NULL CHECK (version BETWEEN 1 AND 9007199254740991),
  enabled boolean NOT NULL DEFAULT false,
  operator_id text NOT NULL CHECK (char_length(operator_id) BETWEEN 1 AND 256 AND operator_id = btrim(operator_id)),
  updated_at timestamptz NOT NULL DEFAULT now() CHECK (isfinite(updated_at))
);

CREATE TABLE proactive_discussion_groups (
  chat_id text PRIMARY KEY,
  context_version bigint NOT NULL DEFAULT 1 CHECK (context_version BETWEEN 1 AND 9007199254740991),
  catalog_version bigint NOT NULL DEFAULT 1 CHECK (catalog_version BETWEEN 1 AND 9007199254740991),
  updated_at timestamptz NOT NULL DEFAULT now() CHECK (isfinite(updated_at))
);

CREATE TABLE proactive_discussion_jobs (
  id text PRIMARY KEY,
  -- Deliberately no FK to policies: registration runs under the message replay
  -- guard and must not acquire an implicit policy key-share lock after message.
  chat_id text NOT NULL CHECK (char_length(chat_id) BETWEEN 1 AND 512),
  message_id text NOT NULL CHECK (char_length(message_id) BETWEEN 1 AND 505),
  content_hash text NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  policy_version bigint NOT NULL CHECK (policy_version BETWEEN 1 AND 9007199254740991),
  purpose text NOT NULL CHECK (purpose IN ('assessment', 'feedback')),
  feedback jsonb,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'processing', 'retry', 'completed', 'cancelled', 'dead_letter')),
  version bigint NOT NULL DEFAULT 1 CHECK (version BETWEEN 1 AND 9007199254740991),
  lease_token text,
  lease_until timestamptz CHECK (lease_until IS NULL OR isfinite(lease_until)),
  worker_id text,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 3),
  available_at timestamptz NOT NULL DEFAULT now() CHECK (isfinite(available_at)),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now() CHECK (isfinite(created_at)),
  updated_at timestamptz NOT NULL DEFAULT now() CHECK (isfinite(updated_at)),
  UNIQUE (id, chat_id),
  CHECK (state <> 'processing' OR (lease_token IS NOT NULL AND lease_until IS NOT NULL AND attempts > 0)),
  CHECK ((purpose = 'assessment' AND feedback IS NULL) OR
    (purpose = 'feedback' AND feedback IS NOT NULL AND jsonb_typeof(feedback) = 'object'
      AND feedback ?& ARRAY['action', 'replyMessageId', 'actorOpenId']
      AND feedback->>'action' IN ('pause', 'resume')
      AND jsonb_typeof(feedback->'replyMessageId') = 'string'
      AND char_length(btrim(feedback->>'replyMessageId')) BETWEEN 1 AND 505
      AND jsonb_typeof(feedback->'actorOpenId') = 'string'
      AND char_length(btrim(feedback->>'actorOpenId')) BETWEEN 1 AND 512))
);
CREATE UNIQUE INDEX proactive_discussion_job_identity
  ON proactive_discussion_jobs(chat_id, message_id, content_hash, policy_version, purpose);
CREATE INDEX proactive_discussion_jobs_claim ON proactive_discussion_jobs(available_at, id)
  WHERE state IN ('pending', 'retry', 'processing');

CREATE TABLE proactive_discussion_evaluations (
  id text PRIMARY KEY,
  job_id text NOT NULL,
  attempt integer NOT NULL CHECK (attempt BETWEEN 1 AND 3),
  chat_id text NOT NULL,
  context_version bigint NOT NULL CHECK (context_version BETWEEN 1 AND 9007199254740991),
  catalog_version bigint NOT NULL CHECK (catalog_version BETWEEN 1 AND 9007199254740991),
  policy_version bigint NOT NULL CHECK (policy_version BETWEEN 1 AND 9007199254740991),
  assessment jsonb NOT NULL CHECK (jsonb_typeof(assessment) = 'object'),
  draft jsonb CHECK (draft IS NULL OR jsonb_typeof(draft) IN ('object', 'null')),
  outcome text CHECK (outcome IN ('prepared', 'skipped', 'stale', 'blocked')),
  created_at timestamptz NOT NULL DEFAULT now() CHECK (isfinite(created_at)),
  FOREIGN KEY (job_id, chat_id) REFERENCES proactive_discussion_jobs(id, chat_id) ON DELETE RESTRICT,
  UNIQUE (job_id, attempt),
  UNIQUE (id, chat_id)
);

CREATE TABLE proactive_discussion_issues (
  id text PRIMARY KEY,
  chat_id text NOT NULL REFERENCES proactive_discussion_groups(chat_id) ON DELETE RESTRICT,
  description text NOT NULL CHECK (char_length(description) BETWEEN 1 AND 4000),
  state text NOT NULL CHECK (state IN ('observing', 'surfaced', 'resolved', 'user_paused')),
  version bigint NOT NULL CHECK (version BETWEEN 1 AND 9007199254740991),
  basis_version bigint NOT NULL CHECK (basis_version BETWEEN 1 AND 9007199254740991),
  last_observation text NOT NULL,
  last_reasoning text NOT NULL,
  last_suggestion text NOT NULL,
  basis_sources jsonb NOT NULL CHECK (jsonb_typeof(basis_sources) = 'array'),
  has_unknown_delivery boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now() CHECK (isfinite(created_at)),
  updated_at timestamptz NOT NULL DEFAULT now() CHECK (isfinite(updated_at)),
  UNIQUE (id, chat_id)
);
CREATE INDEX proactive_discussion_issues_chat ON proactive_discussion_issues(chat_id, id);

CREATE TABLE proactive_discussion_deliveries (
  id text PRIMARY KEY,
  chat_id text NOT NULL,
  issue_id text NOT NULL,
  evaluation_id text,
  issue_version bigint NOT NULL CHECK (issue_version BETWEEN 1 AND 9007199254740991),
  basis_version bigint NOT NULL CHECK (basis_version BETWEEN 1 AND 9007199254740991),
  policy_version bigint NOT NULL CHECK (policy_version BETWEEN 1 AND 9007199254740991),
  context_version bigint NOT NULL CHECK (context_version BETWEEN 1 AND 9007199254740991),
  trigger_message_id text NOT NULL CHECK (char_length(trigger_message_id) BETWEEN 1 AND 505),
  text text NOT NULL CHECK (char_length(btrim(text)) BETWEEN 1 AND 8000),
  reply_uuid text NOT NULL CHECK (char_length(btrim(reply_uuid)) BETWEEN 1 AND 128),
  state text NOT NULL DEFAULT 'prepared' CHECK (state IN ('prepared', 'sending', 'sent', 'cancelled', 'outcome_unknown')),
  version bigint NOT NULL DEFAULT 1 CHECK (version BETWEEN 1 AND 9007199254740991),
  authorization_kind text NOT NULL DEFAULT 'policy' CHECK (authorization_kind = 'policy'),
  lease_token text,
  lease_until timestamptz CHECK (lease_until IS NULL OR isfinite(lease_until)),
  worker_id text,
  reply_message_id text,
  attempted_at timestamptz CHECK (attempted_at IS NULL OR isfinite(attempted_at)),
  sent_at timestamptz CHECK (sent_at IS NULL OR isfinite(sent_at)),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now() CHECK (isfinite(created_at)),
  updated_at timestamptz NOT NULL DEFAULT now() CHECK (isfinite(updated_at)),
  FOREIGN KEY (issue_id, chat_id) REFERENCES proactive_discussion_issues(id, chat_id) ON DELETE RESTRICT,
  FOREIGN KEY (evaluation_id, chat_id) REFERENCES proactive_discussion_evaluations(id, chat_id) ON DELETE RESTRICT,
  CHECK (state <> 'sent' OR (reply_message_id IS NOT NULL AND char_length(btrim(reply_message_id)) BETWEEN 1 AND 505
    AND attempted_at IS NOT NULL AND sent_at IS NOT NULL)),
  CHECK (state NOT IN ('sending', 'outcome_unknown') OR attempted_at IS NOT NULL),
  UNIQUE (id, chat_id)
);
CREATE UNIQUE INDEX proactive_discussion_delivery_identity
  ON proactive_discussion_deliveries(chat_id, issue_id, basis_version, policy_version);
CREATE UNIQUE INDEX proactive_discussion_delivery_uuid ON proactive_discussion_deliveries(reply_uuid);
CREATE INDEX proactive_discussion_deliveries_pending ON proactive_discussion_deliveries(state, created_at, id)
  WHERE state IN ('prepared', 'sending', 'outcome_unknown');

CREATE FUNCTION proactive_discussion_valid_binding(kind text, binding jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(jsonb_typeof(binding) = 'object' AND CASE kind
    WHEN 'message' THEN binding ?& ARRAY['chatId','messageId','contentHash']
      AND jsonb_typeof(binding->'chatId') = 'string'
      AND char_length(btrim(binding->>'chatId')) BETWEEN 1 AND 512
      AND jsonb_typeof(binding->'messageId') = 'string'
      AND char_length(btrim(binding->>'messageId')) BETWEEN 1 AND 505
      AND binding->>'contentHash' ~ '^[a-f0-9]{64}$'
    WHEN 'document' THEN binding ?& ARRAY['documentSourceId','documentSnapshotId']
      AND jsonb_typeof(binding->'documentSourceId') = 'string'
      AND char_length(btrim(binding->>'documentSourceId')) BETWEEN 1 AND 512
      AND jsonb_typeof(binding->'documentSnapshotId') = 'string'
      AND char_length(btrim(binding->>'documentSnapshotId')) BETWEEN 1 AND 512
      AND (NOT binding ?| ARRAY['crossGroupGrantId','crossGroupGrantVersion','crossGroupGrantorGroupId','crossGroupGranteeGroupId']
        OR (binding ?& ARRAY['crossGroupGrantId','crossGroupGrantVersion','crossGroupGrantorGroupId','crossGroupGranteeGroupId']
          AND jsonb_typeof(binding->'crossGroupGrantId') = 'string'
          AND char_length(btrim(binding->>'crossGroupGrantId')) BETWEEN 1 AND 512
          AND jsonb_typeof(binding->'crossGroupGrantorGroupId') = 'string'
          AND char_length(btrim(binding->>'crossGroupGrantorGroupId')) BETWEEN 1 AND 512
          AND jsonb_typeof(binding->'crossGroupGranteeGroupId') = 'string'
          AND char_length(btrim(binding->>'crossGroupGranteeGroupId')) BETWEEN 1 AND 512
          AND jsonb_typeof(binding->'crossGroupGrantVersion') = 'number'
          AND binding->>'crossGroupGrantVersion' ~ '^[1-9][0-9]{0,15}$'
          AND (binding->>'crossGroupGrantVersion')::numeric <= 9007199254740991))
    ELSE false END, false)
$$;

CREATE TABLE proactive_discussion_sources (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  evaluation_id text REFERENCES proactive_discussion_evaluations(id) ON DELETE RESTRICT,
  delivery_id text REFERENCES proactive_discussion_deliveries(id) ON DELETE RESTRICT,
  source_index integer NOT NULL CHECK (source_index BETWEEN 0 AND 999),
  kind text NOT NULL CHECK (kind IN ('message', 'document')),
  ref text NOT NULL CHECK (ref ~ ('^' || kind || ':[a-f0-9]{64}$')),
  binding jsonb NOT NULL CHECK (proactive_discussion_valid_binding(kind, binding)),
  created_at timestamptz NOT NULL DEFAULT now() CHECK (isfinite(created_at)),
  CHECK ((evaluation_id IS NULL) <> (delivery_id IS NULL)),
  UNIQUE (evaluation_id, source_index),
  UNIQUE (delivery_id, source_index)
);

CREATE TABLE proactive_discussion_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  chat_id text NOT NULL,
  entity_type text NOT NULL CHECK (entity_type IN ('policy', 'group', 'job', 'issue', 'delivery')),
  entity_id text NOT NULL,
  operation text NOT NULL CHECK (operation IN ('INSERT', 'UPDATE', 'DELETE')),
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now() CHECK (isfinite(created_at))
);
CREATE INDEX proactive_discussion_events_entity ON proactive_discussion_events(entity_type, entity_id, id);

-- Task 6 consumes this schema; it must not rewrite an already-applied 0059.
CREATE TABLE answer_reply_local_source_traces (
  delivery_id text NOT NULL REFERENCES answer_reply_deliveries(id) ON DELETE RESTRICT,
  trace_index integer NOT NULL CHECK (trace_index BETWEEN 0 AND 999),
  chat_id text NOT NULL CHECK (char_length(chat_id) BETWEEN 1 AND 512 AND chat_id = btrim(chat_id)),
  message_id text NOT NULL CHECK (char_length(message_id) BETWEEN 1 AND 505 AND message_id = btrim(message_id)),
  content_hash text NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  PRIMARY KEY (delivery_id, trace_index)
);
CREATE INDEX answer_reply_local_sources_message ON answer_reply_local_source_traces(message_id, delivery_id);

DO $$ DECLARE fact_table text; BEGIN
  FOREACH fact_table IN ARRAY ARRAY['proactive_discussion_evaluations','proactive_discussion_sources',
    'proactive_discussion_events','answer_reply_local_source_traces'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION knowledge_draft_append_only_guard()',
      fact_table || '_append_only', fact_table);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION knowledge_draft_append_only_guard()',
      fact_table || '_truncate_guard', fact_table);
  END LOOP;
END $$;

CREATE FUNCTION proactive_discussion_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE row_data jsonb;
BEGIN
  IF TG_OP = 'DELETE' THEN row_data := to_jsonb(OLD); ELSE row_data := to_jsonb(NEW); END IF;
  INSERT INTO proactive_discussion_events(chat_id,entity_type,entity_id,operation,payload)
    VALUES (row_data->>'chat_id', TG_ARGV[0], COALESCE(row_data->>'id',row_data->>'chat_id'), TG_OP, row_data);
  RETURN NULL;
END $$;
CREATE TRIGGER proactive_discussion_policy_audit AFTER INSERT OR UPDATE OR DELETE ON proactive_discussion_policies
  FOR EACH ROW EXECUTE FUNCTION proactive_discussion_audit_mutation('policy');
CREATE TRIGGER proactive_discussion_group_audit AFTER INSERT OR UPDATE OR DELETE ON proactive_discussion_groups
  FOR EACH ROW EXECUTE FUNCTION proactive_discussion_audit_mutation('group');
CREATE TRIGGER proactive_discussion_job_audit AFTER INSERT OR UPDATE OR DELETE ON proactive_discussion_jobs
  FOR EACH ROW EXECUTE FUNCTION proactive_discussion_audit_mutation('job');
CREATE TRIGGER proactive_discussion_issue_audit AFTER INSERT OR UPDATE OR DELETE ON proactive_discussion_issues
  FOR EACH ROW EXECUTE FUNCTION proactive_discussion_audit_mutation('issue');
CREATE TRIGGER proactive_discussion_delivery_audit AFTER INSERT OR UPDATE OR DELETE ON proactive_discussion_deliveries
  FOR EACH ROW EXECUTE FUNCTION proactive_discussion_audit_mutation('delivery');

CREATE FUNCTION proactive_discussion_initialize_group() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO proactive_discussion_groups(chat_id,updated_at) VALUES (NEW.chat_id,NEW.updated_at) ON CONFLICT DO NOTHING;
  RETURN NULL;
END $$;
CREATE TRIGGER proactive_discussion_policy_group AFTER INSERT ON proactive_discussion_policies
  FOR EACH ROW EXECUTE FUNCTION proactive_discussion_initialize_group();

CREATE FUNCTION proactive_discussion_invalidate_context() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE affected text[]; target_chat text;
BEGIN
  IF TG_OP = 'INSERT' THEN affected := ARRAY[NEW.chat_id];
  ELSIF TG_OP = 'DELETE' THEN affected := ARRAY[OLD.chat_id];
  ELSE affected := ARRAY[OLD.chat_id,NEW.chat_id]; END IF;
  -- A move locks both group rows in deterministic order, never policy/runtime rows.
  -- Unregistered chats have no new-domain writes; only existing policies count.
  FOR target_chat IN SELECT g.chat_id FROM proactive_discussion_groups g
    WHERE g.chat_id = ANY(affected) AND EXISTS
      (SELECT 1 FROM proactive_discussion_policies p WHERE p.chat_id = g.chat_id)
    ORDER BY g.chat_id FOR UPDATE OF g LOOP
    UPDATE proactive_discussion_groups SET context_version = context_version + 1, updated_at = now()
      WHERE chat_id = target_chat;
  END LOOP;
  RETURN NULL;
END $$;
CREATE TRIGGER proactive_discussion_message_insert AFTER INSERT ON conversation_messages
  FOR EACH ROW EXECUTE FUNCTION proactive_discussion_invalidate_context();
CREATE TRIGGER proactive_discussion_message_update AFTER UPDATE ON conversation_messages
  FOR EACH ROW WHEN (OLD.text IS DISTINCT FROM NEW.text OR OLD.chat_id IS DISTINCT FROM NEW.chat_id
    OR OLD.sender_open_id IS DISTINCT FROM NEW.sender_open_id OR OLD.message_type IS DISTINCT FROM NEW.message_type)
  EXECUTE FUNCTION proactive_discussion_invalidate_context();
CREATE TRIGGER proactive_discussion_message_delete AFTER DELETE ON conversation_messages
  FOR EACH ROW EXECUTE FUNCTION proactive_discussion_invalidate_context();
CREATE TRIGGER proactive_discussion_tombstone_insert AFTER INSERT ON conversation_message_deletion_tombstones
  FOR EACH ROW EXECUTE FUNCTION proactive_discussion_invalidate_context();
