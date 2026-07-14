CREATE TABLE group_memory_extraction_runs (
  id TEXT PRIMARY KEY CHECK (char_length(id) BETWEEN 1 AND 512),
  group_id TEXT NOT NULL CHECK (char_length(group_id) BETWEEN 1 AND 512),
  input_fingerprint TEXT NOT NULL CHECK (input_fingerprint ~ '^[0-9a-f]{64}$'),
  status TEXT NOT NULL CHECK (status IN ('processing', 'completed', 'failed')),
  failure_classification TEXT CHECK (
    failure_classification IS NULL
    OR char_length(failure_classification) BETWEEN 1 AND 128
  ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (input_fingerprint),
  CHECK ((status = 'completed') = (completed_at IS NOT NULL))
);

CREATE TABLE group_memory_extraction_requests (
  id TEXT PRIMARY KEY CHECK (char_length(id) BETWEEN 1 AND 512),
  group_id TEXT NOT NULL CHECK (char_length(group_id) BETWEEN 1 AND 512),
  conversation_message_id TEXT NOT NULL REFERENCES conversation_messages(id) ON DELETE RESTRICT,
  provider_message_id TEXT NOT NULL CHECK (char_length(provider_message_id) BETWEEN 1 AND 512),
  status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'completed', 'skipped')),
  run_id TEXT REFERENCES group_memory_extraction_runs(id) ON DELETE RESTRICT,
  skip_reason TEXT CHECK (skip_reason IS NULL OR char_length(skip_reason) BETWEEN 1 AND 128),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (conversation_message_id),
  UNIQUE (provider_message_id),
  CHECK (status NOT IN ('processing', 'completed') OR run_id IS NOT NULL),
  CHECK (status <> 'skipped' OR skip_reason IS NOT NULL)
);

CREATE INDEX group_memory_extraction_requests_pending_group_idx
  ON group_memory_extraction_requests (group_id, status, created_at, id);

CREATE INDEX group_memory_extraction_requests_run_idx
  ON group_memory_extraction_requests (run_id, id)
  WHERE run_id IS NOT NULL;

CREATE TABLE group_memory_extraction_run_evidence (
  run_id TEXT NOT NULL REFERENCES group_memory_extraction_runs(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL REFERENCES group_memory_extraction_requests(id) ON DELETE CASCADE,
  conversation_message_id TEXT NOT NULL REFERENCES conversation_messages(id) ON DELETE RESTRICT,
  ordinal SMALLINT NOT NULL CHECK (ordinal BETWEEN 0 AND 39),
  content_hash TEXT NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  PRIMARY KEY (run_id, conversation_message_id),
  UNIQUE (run_id, request_id),
  UNIQUE (run_id, ordinal)
);

CREATE TABLE group_memory_extraction_run_context (
  run_id TEXT NOT NULL REFERENCES group_memory_extraction_runs(id) ON DELETE CASCADE,
  conversation_message_id TEXT NOT NULL REFERENCES conversation_messages(id) ON DELETE RESTRICT,
  ordinal SMALLINT NOT NULL CHECK (ordinal BETWEEN 0 AND 9),
  content_hash TEXT NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  PRIMARY KEY (run_id, conversation_message_id),
  UNIQUE (run_id, ordinal)
);

CREATE TABLE group_memory_extraction_run_memories (
  run_id TEXT NOT NULL REFERENCES group_memory_extraction_runs(id) ON DELETE CASCADE,
  memory_id TEXT NOT NULL REFERENCES group_memories(id) ON DELETE RESTRICT,
  ordinal SMALLINT NOT NULL CHECK (ordinal BETWEEN 0 AND 7),
  memory_updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (run_id, memory_id),
  UNIQUE (run_id, ordinal)
);
