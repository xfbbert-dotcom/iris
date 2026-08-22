ALTER TABLE knowledge_publication_update_executions
  ADD COLUMN approval_id TEXT REFERENCES action_approvals(id) ON DELETE RESTRICT,
  ADD COLUMN executor_id TEXT CHECK (
    executor_id IS NULL OR char_length(executor_id) BETWEEN 1 AND 512
  ),
  ADD CONSTRAINT managed_update_execution_identity_pair_check CHECK (
    (approval_id IS NULL) = (executor_id IS NULL)
  );

CREATE INDEX managed_update_executions_approval_idx
  ON knowledge_publication_update_executions (approval_id)
  WHERE approval_id IS NOT NULL;

CREATE FUNCTION require_managed_update_execution_identity()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' AND (NEW.approval_id IS NULL OR NEW.executor_id IS NULL) THEN
    RAISE EXCEPTION 'managed update execution requires approval and executor identity';
  ELSIF TG_OP = 'UPDATE' AND (
    OLD.approval_id IS DISTINCT FROM NEW.approval_id
    OR OLD.executor_id IS DISTINCT FROM NEW.executor_id
  ) THEN
    RAISE EXCEPTION 'managed update execution identity is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER knowledge_publication_update_executions_identity_guard
BEFORE INSERT OR UPDATE ON knowledge_publication_update_executions
FOR EACH ROW EXECUTE FUNCTION require_managed_update_execution_identity();
