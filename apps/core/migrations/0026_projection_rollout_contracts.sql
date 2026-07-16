DO $$
DECLARE
  legacy_constraints TEXT[];
BEGIN
  SELECT array_agg(conname ORDER BY conname)
  INTO legacy_constraints
    FROM pg_constraint
    WHERE conrelid = 'group_memories'::regclass
      AND contype = 'c'
      AND btrim(regexp_replace(lower(pg_get_expr(conbin, conrelid, true)), '\s+', ' ', 'g')) =
        'memory_scope = ''thread''::text and thread_key is not null or memory_scope <> ''thread''::text and thread_key is null';

  IF COALESCE(cardinality(legacy_constraints), 0) <> 1 THEN
    RAISE EXCEPTION 'expected exactly one legacy group memory scope constraint, found %',
      COALESCE(cardinality(legacy_constraints), 0)
      USING ERRCODE = 'check_violation';
  END IF;

  EXECUTE format(
    'ALTER TABLE group_memories DROP CONSTRAINT %I',
    legacy_constraints[1]
  );
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
