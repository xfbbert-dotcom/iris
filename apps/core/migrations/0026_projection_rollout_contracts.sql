DO $$
DECLARE
  existing_constraint RECORD;
BEGIN
  FOR existing_constraint IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'group_memories'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%memory_scope%'
      AND pg_get_constraintdef(oid) ILIKE '%thread_key%'
  LOOP
    EXECUTE format(
      'ALTER TABLE group_memories DROP CONSTRAINT %I',
      existing_constraint.conname
    );
  END LOOP;
END $$;

ALTER TABLE group_memories
  ADD CONSTRAINT group_memories_scope_thread_key_check CHECK (
    (memory_scope = 'thread' AND thread_key IS NOT NULL)
    OR (memory_scope = 'group' AND thread_key IS NULL)
    OR memory_scope = 'action'
  );

ALTER TABLE group_memory_extraction_runs
  ADD COLUMN thread_operation_rejected_count SMALLINT NOT NULL DEFAULT 0
    CHECK (thread_operation_rejected_count BETWEEN 0 AND 8),
  ADD COLUMN action_operation_rejected_count SMALLINT NOT NULL DEFAULT 0
    CHECK (action_operation_rejected_count BETWEEN 0 AND 8);
