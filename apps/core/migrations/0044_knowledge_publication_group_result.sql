ALTER TABLE knowledge_draft_presentation_outbox
  DROP CONSTRAINT IF EXISTS knowledge_draft_presentation_outbox_presentation_id_key;

ALTER TABLE knowledge_draft_presentation_outbox
  ADD COLUMN delivery_sequence INTEGER NOT NULL DEFAULT 1
    CHECK (delivery_sequence >= 1);

ALTER TABLE knowledge_draft_presentation_outbox
  ADD CONSTRAINT knowledge_draft_presentation_outbox_delivery_sequence_key
    UNIQUE (presentation_id, delivery_sequence);

CREATE INDEX knowledge_draft_presentation_outbox_presentation_order_idx
  ON knowledge_draft_presentation_outbox (
    presentation_id, delivery_sequence ASC, created_at ASC, id ASC
  );
