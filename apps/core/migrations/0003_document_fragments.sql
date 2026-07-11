create extension if not exists vector;

create table document_fragments (
  id text primary key,
  document_source_id text not null references document_sources(id) on delete cascade,
  document_snapshot_id text not null references document_snapshots(id) on delete cascade,
  source_uri text not null,
  chunk_index integer not null check (chunk_index >= 0),
  text text not null check (length(trim(text)) > 0),
  content_hash text not null,
  embedding vector(6) not null,
  created_at timestamptz not null,
  unique (document_snapshot_id, chunk_index)
);

create index document_fragments_document_source_id_idx
  on document_fragments (document_source_id, chunk_index asc, id asc);

create index document_fragments_document_snapshot_id_idx
  on document_fragments (document_snapshot_id, chunk_index asc, id asc);
