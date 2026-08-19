ALTER TABLE knowledge_conflict_draft_governance_attestations
  DROP CONSTRAINT knowledge_conflict_draft_governance_attestations_pkey;

ALTER TABLE knowledge_conflict_draft_governance_attestations
  ADD PRIMARY KEY (
    draft_id,
    revision_number,
    document_source_id,
    permission_attested_at
  );
