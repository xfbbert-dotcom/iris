ALTER TABLE group_memory_extraction_runs
  ADD COLUMN enabled_operation_families TEXT[] NOT NULL
    DEFAULT ARRAY['memory', 'thread', 'action']::TEXT[],
  ADD CONSTRAINT group_memory_extraction_runs_enabled_operation_families_check CHECK (
    enabled_operation_families = ARRAY['memory']::TEXT[]
    OR enabled_operation_families = ARRAY['memory', 'thread']::TEXT[]
    OR enabled_operation_families = ARRAY['memory', 'thread', 'action']::TEXT[]
  );

ALTER TABLE conversation_messages
  ADD COLUMN sender_open_id TEXT CHECK (
    sender_open_id IS NULL OR char_length(sender_open_id) BETWEEN 1 AND 512
  ),
  ADD COLUMN sender_union_id TEXT CHECK (
    sender_union_id IS NULL OR char_length(sender_union_id) BETWEEN 1 AND 512
  ),
  ADD COLUMN sender_user_id TEXT CHECK (
    sender_user_id IS NULL OR char_length(sender_user_id) BETWEEN 1 AND 512
  );

ALTER TABLE discussion_threads
  ADD COLUMN retrieval_state TEXT NOT NULL DEFAULT 'visible'
    CHECK (retrieval_state IN ('visible', 'invalidated'));

ALTER TABLE action_items
  ADD COLUMN retrieval_state TEXT NOT NULL DEFAULT 'visible'
    CHECK (retrieval_state IN ('visible', 'invalidated'));

ALTER TABLE discussion_thread_events
  DROP CONSTRAINT discussion_thread_events_event_type_check,
  ADD CONSTRAINT discussion_thread_events_event_type_check CHECK (event_type IN (
    'created', 'promoted', 'summary_updated', 'resolved', 'reopened',
    'merged', 'corrected', 'evidence_attached', 'evidence_deleted'
  ));

ALTER TABLE action_item_events
  DROP CONSTRAINT action_item_events_event_type_check,
  ADD CONSTRAINT action_item_events_event_type_check CHECK (event_type IN (
    'created', 'completed', 'cancelled', 'reopened', 'owner_resolved',
    'corrected', 'evidence_deleted'
  ));

DROP TRIGGER discussion_thread_event_evidence_append_only
  ON discussion_thread_event_evidence;
CREATE TRIGGER discussion_thread_event_evidence_append_only
BEFORE UPDATE ON discussion_thread_event_evidence
FOR EACH ROW EXECUTE FUNCTION conversation_state_event_append_only_guard();

DROP TRIGGER action_item_event_evidence_append_only
  ON action_item_event_evidence;
CREATE TRIGGER action_item_event_evidence_append_only
BEFORE UPDATE ON action_item_event_evidence
FOR EACH ROW EXECUTE FUNCTION conversation_state_event_append_only_guard();

ALTER TABLE group_memory_extraction_requests
  DROP CONSTRAINT group_memory_extraction_requests_conversation_message_id_fkey,
  ALTER COLUMN conversation_message_id DROP NOT NULL,
  ADD CONSTRAINT group_memory_extraction_requests_conversation_message_id_fkey
    FOREIGN KEY (conversation_message_id)
    REFERENCES conversation_messages(id) ON DELETE SET NULL;
