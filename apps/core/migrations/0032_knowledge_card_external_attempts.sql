ALTER TABLE knowledge_draft_presentation_outbox
  DROP CONSTRAINT knowledge_draft_presentation_outbox_state_check;

ALTER TABLE knowledge_draft_presentation_outbox
  ADD CONSTRAINT knowledge_draft_presentation_outbox_state_check CHECK (state IN (
    'pending', 'processing', 'external_attempting', 'sent', 'failed', 'outcome_unknown'
  ));
