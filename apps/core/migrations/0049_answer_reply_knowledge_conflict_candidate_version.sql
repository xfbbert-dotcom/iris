ALTER TABLE answer_reply_knowledge_conflicts
  ADD COLUMN candidate_version BIGINT;

DROP TRIGGER answer_reply_knowledge_conflicts_append_only
  ON answer_reply_knowledge_conflicts;

UPDATE answer_reply_knowledge_conflicts binding
SET candidate_version = candidate.version
FROM knowledge_conflict_candidates candidate
WHERE candidate.id = binding.candidate_id;

ALTER TABLE answer_reply_knowledge_conflicts
  ALTER COLUMN candidate_version SET NOT NULL;

ALTER TABLE answer_reply_knowledge_conflicts
  ADD CONSTRAINT answer_reply_knowledge_conflicts_candidate_version_check
  CHECK (candidate_version >= 1);

CREATE TRIGGER answer_reply_knowledge_conflicts_append_only
BEFORE UPDATE OR DELETE ON answer_reply_knowledge_conflicts
FOR EACH ROW EXECUTE FUNCTION knowledge_draft_append_only_guard();
