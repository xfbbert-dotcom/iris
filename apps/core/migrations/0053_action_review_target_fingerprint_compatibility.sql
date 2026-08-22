ALTER TABLE action_review_attestations
  ADD COLUMN IF NOT EXISTS action_target_fingerprint TEXT;

DROP TRIGGER IF EXISTS action_review_attestations_append_only
  ON action_review_attestations;
UPDATE action_review_attestations
SET action_target_fingerprint = content_hash
WHERE action_target_fingerprint IS NULL;
CREATE TRIGGER action_review_attestations_append_only
BEFORE UPDATE OR DELETE ON action_review_attestations
FOR EACH ROW EXECUTE FUNCTION knowledge_draft_append_only_guard();

ALTER TABLE action_review_attestations
  DROP CONSTRAINT IF EXISTS action_review_attestations_action_target_fingerprint_check;
ALTER TABLE action_review_attestations
  ADD CONSTRAINT action_review_attestations_action_target_fingerprint_check
    CHECK (action_target_fingerprint ~ '^[0-9a-f]{64}$');
ALTER TABLE action_review_attestations
  ALTER COLUMN action_target_fingerprint SET NOT NULL;

DO $$
DECLARE
  legacy_constraint_name TEXT;
BEGIN
  FOR legacy_constraint_name IN
    SELECT candidate.conname
    FROM pg_constraint candidate
    WHERE candidate.conrelid = 'action_review_attestations'::regclass
      AND candidate.contype = 'u'
      AND (
        SELECT array_agg(attribute.attname::TEXT ORDER BY key.ordinality)
        FROM unnest(candidate.conkey) WITH ORDINALITY AS key(attnum, ordinality)
        JOIN pg_attribute attribute
          ON attribute.attrelid = candidate.conrelid
         AND attribute.attnum = key.attnum
      ) = ARRAY[
        'proposal_id', 'proposal_version', 'actor_open_id', 'content_hash'
      ]::TEXT[]
  LOOP
    EXECUTE format(
      'ALTER TABLE action_review_attestations DROP CONSTRAINT %I',
      legacy_constraint_name
    );
  END LOOP;
END
$$;

ALTER TABLE action_review_attestations
  DROP CONSTRAINT IF EXISTS action_review_attestations_exact_target_key;
ALTER TABLE action_review_attestations
  ADD CONSTRAINT action_review_attestations_exact_target_key
  UNIQUE (proposal_id, proposal_version, actor_open_id, content_hash, action_target_fingerprint);
