ALTER TABLE knowledge_drafts
  ADD COLUMN published_at TIMESTAMPTZ,
  ADD COLUMN published_by TEXT;
