create table document_sources (
  id text primary key,
  source_type text not null check (
    source_type in (
      'group_visible_document',
      'authorized_wiki_document',
      'user_submitted_document'
    )
  ),
  source_uri text not null unique,
  title text,
  origin_group_id text,
  origin_message_id text,
  submitted_by_user_id text,
  authorized_space_id text,
  permission_state text not null check (
    permission_state in ('unknown', 'readable', 'denied', 'stale')
  ),
  sync_state text not null check (
    sync_state in ('pending', 'syncing', 'synced', 'failed')
  ),
  can_use_for_answering boolean not null,
  can_use_for_knowledge_drafts boolean not null,
  created_at timestamptz not null,
  updated_at timestamptz not null
);

create index document_sources_updated_at_id_idx
  on document_sources (updated_at desc, id asc);

create index document_sources_source_type_idx
  on document_sources (source_type);

create index document_sources_origin_group_id_idx
  on document_sources (origin_group_id);

create index document_sources_authorized_space_id_idx
  on document_sources (authorized_space_id);

create index document_sources_submitted_by_user_id_idx
  on document_sources (submitted_by_user_id);

create table document_source_evidence (
  id bigserial primary key,
  document_source_id text not null references document_sources(id) on delete cascade,
  kind text not null check (
    kind in ('group_message', 'admin_authorization', 'user_submission')
  ),
  source_uri text not null,
  group_id text,
  message_id text,
  user_id text,
  space_id text,
  observed_at timestamptz not null,
  created_at timestamptz not null
);

create unique index document_source_evidence_dedupe_idx
  on document_source_evidence (
    kind,
    source_uri,
    coalesce(group_id, ''),
    coalesce(message_id, ''),
    coalesce(user_id, ''),
    coalesce(space_id, '')
  );

create index document_source_evidence_document_source_id_idx
  on document_source_evidence (document_source_id);

create index document_source_evidence_group_id_idx
  on document_source_evidence (group_id);

create index document_source_evidence_space_id_idx
  on document_source_evidence (space_id);

create index document_source_evidence_user_id_idx
  on document_source_evidence (user_id);
