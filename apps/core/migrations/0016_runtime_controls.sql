create table runtime_controls (
  scope text not null,
  target_id text not null,
  enabled boolean not null,
  updated_at timestamptz not null default now(),
  primary key (scope, target_id),
  constraint runtime_controls_valid_target check (
    (scope = 'global' and target_id = 'global')
    or (
      scope = 'group'
      and length(target_id) between 1 and 512
      and enabled = false
    )
    or (
      scope = 'capability'
      and target_id in (
        'readGroupContext',
        'replyWhenMentioned',
        'readGroupDocuments',
        'retrieveKnowledgeBase',
        'proactiveSpeech',
        'generateKnowledgeDrafts',
        'writeKnowledgeBase',
        'callExternalTools'
      )
    )
  )
);
