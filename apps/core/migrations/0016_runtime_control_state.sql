create table runtime_control_state (
  singleton_id smallint primary key check (singleton_id = 1),
  revision bigint not null check (revision >= 0),
  desired_global_enabled boolean not null,
  disabled_group_ids text[] not null,
  capabilities jsonb not null,
  updated_at timestamptz not null,
  updated_by text null
);

insert into runtime_control_state (
  singleton_id,
  revision,
  desired_global_enabled,
  disabled_group_ids,
  capabilities,
  updated_at,
  updated_by
)
values (1,
  0,
  false,
  array[]::text[],
  '{"readGroupContext":true,"replyWhenMentioned":true,"readGroupDocuments":true,"retrieveKnowledgeBase":true,"proactiveSpeech":true,"generateKnowledgeDrafts":true,"writeKnowledgeBase":false,"callExternalTools":false}'::jsonb,
  now(),
  null
);
