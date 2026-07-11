create table if not exists embedding_profiles (
  id text primary key,
  provider text not null check (length(trim(provider)) > 0),
  model text not null check (length(trim(model)) > 0),
  dimensions integer not null check (dimensions > 0),
  display_name text not null check (length(trim(display_name)) > 0),
  status text not null check (status in ('active', 'deprecated')),
  created_at timestamptz not null,
  unique (provider, model, dimensions)
);

insert into embedding_profiles (
  id,
  provider,
  model,
  dimensions,
  display_name,
  status,
  created_at
)
values (
  'static-dev-6d',
  'static-dev',
  'static-dev-6d',
  6,
  'Static development embeddings (6d)',
  'active',
  now()
)
on conflict (provider, model, dimensions) do nothing;

alter table document_fragments
  add column if not exists embedding_profile_id text;

update document_fragments
set embedding_profile_id = 'static-dev-6d'
where embedding_profile_id is null;

alter table document_fragments
  alter column embedding_profile_id set not null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'document_fragments_embedding_profile_id_fkey'
  ) then
    alter table document_fragments
      add constraint document_fragments_embedding_profile_id_fkey
      foreign key (embedding_profile_id)
      references embedding_profiles(id);
  end if;
end $$;

create index if not exists document_fragments_profile_chunk_idx
on document_fragments (embedding_profile_id, document_source_id, chunk_index asc, id asc);
