CREATE TABLE group_memory_extraction_conflict_candidates (
  run_id TEXT NOT NULL REFERENCES group_memory_extraction_runs(id) ON DELETE CASCADE,
  ordinal SMALLINT NOT NULL CHECK (ordinal BETWEEN 0 AND 7),
  category TEXT NOT NULL CHECK (
    category IN ('project', 'preference', 'person', 'term', 'workflow', 'decision')
  ),
  content TEXT NOT NULL CHECK (char_length(content) BETWEEN 1 AND 4000),
  importance SMALLINT NOT NULL CHECK (importance BETWEEN 1 AND 5),
  confidence DOUBLE PRECISION NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  target_memory_id TEXT REFERENCES group_memories(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (run_id, ordinal)
);

CREATE INDEX group_memory_extraction_conflict_candidates_target_idx
ON group_memory_extraction_conflict_candidates (target_memory_id)
WHERE target_memory_id IS NOT NULL;

CREATE TABLE group_memory_extraction_conflict_evidence (
  run_id TEXT NOT NULL,
  conflict_ordinal SMALLINT NOT NULL CHECK (conflict_ordinal BETWEEN 0 AND 7),
  conversation_message_id TEXT NOT NULL
    REFERENCES conversation_messages(id) ON DELETE RESTRICT,
  ordinal SMALLINT NOT NULL CHECK (ordinal BETWEEN 0 AND 39),
  PRIMARY KEY (run_id, conflict_ordinal, conversation_message_id),
  UNIQUE (run_id, conflict_ordinal, ordinal),
  FOREIGN KEY (run_id, conflict_ordinal)
    REFERENCES group_memory_extraction_conflict_candidates (run_id, ordinal)
    ON DELETE CASCADE
);
