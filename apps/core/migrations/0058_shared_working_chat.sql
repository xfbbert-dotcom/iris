CREATE FUNCTION valid_working_chat_groups(group_entries jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  entry jsonb;
  chat_ids text[] := ARRAY[]::text[];
  chat_id text;
  display_name text;
BEGIN
  IF jsonb_typeof(group_entries) <> 'array' THEN RETURN false; END IF;
  IF jsonb_array_length(group_entries) NOT BETWEEN 2 AND 5 THEN RETURN false; END IF;
  FOR entry IN SELECT value FROM jsonb_array_elements(group_entries) LOOP
    IF jsonb_typeof(entry) <> 'object' THEN RETURN false; END IF;
    IF (SELECT count(*) FROM jsonb_object_keys(entry)) <> 2
      OR jsonb_typeof(entry->'chatId') IS DISTINCT FROM 'string'
      OR jsonb_typeof(entry->'name') IS DISTINCT FROM 'string' THEN RETURN false; END IF;
    chat_id := entry->>'chatId';
    display_name := entry->>'name';
    IF char_length(chat_id) NOT BETWEEN 1 AND 512 OR chat_id <> btrim(chat_id)
      OR char_length(display_name) NOT BETWEEN 1 AND 256 OR display_name <> btrim(display_name)
      OR chat_id = ANY(chat_ids) THEN RETURN false; END IF;
    chat_ids := array_append(chat_ids, chat_id);
  END LOOP;
  RETURN true;
END;
$$;

CREATE TABLE working_chat_scopes (
  id text PRIMARY KEY CHECK (id = 'pilot-working-chat'),
  version bigint NOT NULL CHECK (version BETWEEN 1 AND 9007199254740991),
  state text NOT NULL CHECK (state IN ('active', 'revoked')),
  groups jsonb NOT NULL CHECK (valid_working_chat_groups(groups)),
  updated_at timestamptz NOT NULL CHECK (isfinite(updated_at)),
  updated_by text NOT NULL CHECK (char_length(updated_by) BETWEEN 1 AND 256 AND updated_by = btrim(updated_by))
);

ALTER TABLE answer_reply_deliveries ADD COLUMN chat_provenance_version smallint
  CHECK (chat_provenance_version = 1);

CREATE TABLE answer_reply_chat_source_traces (
  delivery_id text NOT NULL REFERENCES answer_reply_deliveries(id),
  trace_index integer NOT NULL CHECK (trace_index BETWEEN 0 AND 999),
  scope_id text NOT NULL CHECK (scope_id = 'pilot-working-chat'),
  scope_version bigint NOT NULL CHECK (scope_version BETWEEN 1 AND 9007199254740991),
  source_chat_id text NOT NULL CHECK (char_length(source_chat_id) BETWEEN 1 AND 512 AND source_chat_id = btrim(source_chat_id)),
  destination_chat_id text NOT NULL CHECK (char_length(destination_chat_id) BETWEEN 1 AND 512 AND destination_chat_id = btrim(destination_chat_id)),
  message_id text NOT NULL CHECK (char_length(message_id) BETWEEN 1 AND 505 AND message_id = btrim(message_id)),
  content_hash text NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  PRIMARY KEY (delivery_id, trace_index),
  CHECK (source_chat_id <> destination_chat_id)
);
CREATE INDEX answer_reply_chat_sources_scope_idx ON answer_reply_chat_source_traces(scope_id, delivery_id);
CREATE INDEX answer_reply_chat_sources_message_idx ON answer_reply_chat_source_traces(message_id, delivery_id);

CREATE TRIGGER answer_reply_chat_source_traces_append_only
BEFORE UPDATE OR DELETE ON answer_reply_chat_source_traces
FOR EACH ROW EXECUTE FUNCTION knowledge_draft_append_only_guard();
