ALTER TABLE group_memory_extraction_runs
ADD COLUMN failure_count BIGINT;

UPDATE group_memory_extraction_runs
SET failure_count = CASE WHEN status = 'failed' THEN 1 ELSE 0 END;

ALTER TABLE group_memory_extraction_runs
ALTER COLUMN failure_count SET DEFAULT 0,
ALTER COLUMN failure_count SET NOT NULL;

ALTER TABLE group_memory_extraction_runs
ADD CONSTRAINT group_memory_extraction_runs_failure_count_nonnegative
CHECK (failure_count >= 0);
