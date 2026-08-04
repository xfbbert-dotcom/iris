create table if not exists document_fragment_embeddings_768 (
  document_fragment_id text primary key references document_fragments(id) on delete cascade,
  embedding_profile_id text not null references embedding_profiles(id),
  embedding vector(768) not null,
  created_at timestamptz not null
);

create index if not exists document_fragment_embeddings_768_profile_idx
on document_fragment_embeddings_768 (embedding_profile_id);
