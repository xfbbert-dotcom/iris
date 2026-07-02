create table document_snapshots (
  id text primary key,
  document_source_id text not null references document_sources(id) on delete cascade,
  source_uri text not null,
  fetch_status text not null check (fetch_status in ('succeeded', 'failed')),
  body_text text,
  content_hash text,
  source_version text,
  fetched_at timestamptz not null,
  error_message text,
  created_at timestamptz not null,
  check (
    (
      fetch_status = 'succeeded'
      and body_text is not null
      and error_message is null
    )
    or (
      fetch_status = 'failed'
      and body_text is null
      and error_message is not null
    )
  )
);

create index document_snapshots_document_source_id_idx
  on document_snapshots (document_source_id, fetched_at desc, id asc);

create index document_snapshots_fetched_at_idx
  on document_snapshots (fetched_at desc, id asc);
