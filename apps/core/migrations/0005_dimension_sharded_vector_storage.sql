create table if not exists document_fragment_embeddings_6 (
  document_fragment_id text primary key references document_fragments(id) on delete cascade,
  embedding_profile_id text not null references embedding_profiles(id),
  embedding vector(6) not null,
  created_at timestamptz not null
);

create index if not exists document_fragment_embeddings_6_profile_idx
on document_fragment_embeddings_6 (embedding_profile_id);

create table if not exists document_fragment_embeddings_1536 (
  document_fragment_id text primary key references document_fragments(id) on delete cascade,
  embedding_profile_id text not null references embedding_profiles(id),
  embedding vector(1536) not null,
  created_at timestamptz not null
);

create index if not exists document_fragment_embeddings_1536_profile_idx
on document_fragment_embeddings_1536 (embedding_profile_id);

insert into document_fragment_embeddings_6 (
  document_fragment_id,
  embedding_profile_id,
  embedding,
  created_at
)
select
  id,
  embedding_profile_id,
  embedding,
  created_at
from document_fragments
where embedding_profile_id = 'static-dev-6d'
on conflict (document_fragment_id) do nothing;

alter table document_fragments
  alter column embedding drop not null;
