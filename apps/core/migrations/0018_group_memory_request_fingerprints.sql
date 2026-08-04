ALTER TABLE group_memories
  ADD COLUMN IF NOT EXISTS request_fingerprint TEXT;

UPDATE group_memories
SET request_fingerprint = repeat('0', 64)
WHERE request_fingerprint IS NULL;

ALTER TABLE group_memories
  ALTER COLUMN request_fingerprint SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'group_memories_request_fingerprint_format_check'
      AND conrelid = 'group_memories'::regclass
  ) THEN
    ALTER TABLE group_memories
      ADD CONSTRAINT group_memories_request_fingerprint_format_check
      CHECK (request_fingerprint ~ '^[0-9a-f]{64}$');
  END IF;
END
$$;
