CREATE TABLE IF NOT EXISTS group_memories (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL CHECK (char_length(group_id) BETWEEN 1 AND 512),
  memory_scope TEXT NOT NULL CHECK (memory_scope IN ('group', 'thread', 'action')),
  category TEXT NOT NULL CHECK (
    category IN (
      'project',
      'preference',
      'person',
      'term',
      'workflow',
      'decision',
      'action',
      'summary'
    )
  ),
  thread_key TEXT CHECK (thread_key IS NULL OR char_length(thread_key) BETWEEN 1 AND 512),
  content TEXT NOT NULL CHECK (char_length(content) BETWEEN 1 AND 4000),
  importance SMALLINT NOT NULL CHECK (importance BETWEEN 1 AND 5),
  confidence DOUBLE PRECISION NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  status TEXT NOT NULL CHECK (status IN ('active', 'superseded')),
  idempotency_key TEXT NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 512),
  origin TEXT NOT NULL CHECK (origin IN ('extractor', 'operator', 'system')),
  created_by TEXT NOT NULL CHECK (char_length(created_by) BETWEEN 1 AND 512),
  supersedes_memory_id TEXT REFERENCES group_memories(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (group_id, idempotency_key),
  CHECK (
    (memory_scope = 'thread' AND thread_key IS NOT NULL)
    OR (memory_scope <> 'thread' AND thread_key IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS group_memories_active_group_order_idx
  ON group_memories (
    group_id,
    status,
    importance DESC,
    updated_at DESC,
    id ASC
  );

CREATE INDEX IF NOT EXISTS group_memories_supersedes_memory_id_idx
  ON group_memories (supersedes_memory_id)
  WHERE supersedes_memory_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS group_memory_message_evidence (
  memory_id TEXT NOT NULL REFERENCES group_memories(id) ON DELETE CASCADE,
  conversation_message_id TEXT NOT NULL REFERENCES conversation_messages(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (memory_id, conversation_message_id)
);

CREATE INDEX IF NOT EXISTS group_memory_message_evidence_message_id_idx
  ON group_memory_message_evidence (conversation_message_id, memory_id);
