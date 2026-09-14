-- Cited issue evidence is not provenance for derived catalog prose. Existing
-- rows have no provable transitive exposure lineage and remain explicitly null.
ALTER TABLE proactive_discussion_issues ADD COLUMN prose_sources jsonb
  CHECK (prose_sources IS NULL OR
    (jsonb_typeof(prose_sources)='array' AND jsonb_array_length(prose_sources) BETWEEN 1 AND 1000));
