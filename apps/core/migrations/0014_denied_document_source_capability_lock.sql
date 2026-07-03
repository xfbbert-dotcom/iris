update document_sources
set
  can_use_for_answering = false,
  can_use_for_knowledge_drafts = false
where permission_state = 'denied'
  and (
    can_use_for_answering = true
    or can_use_for_knowledge_drafts = true
  );

alter table document_sources
  add constraint document_sources_denied_capabilities_disabled
  check (
    permission_state <> 'denied'
    or (
      can_use_for_answering = false
      and can_use_for_knowledge_drafts = false
    )
  );
