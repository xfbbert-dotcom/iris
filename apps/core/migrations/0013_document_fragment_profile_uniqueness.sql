alter table document_fragments
  drop constraint if exists document_fragments_document_snapshot_id_chunk_index_key;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'document_fragments_snapshot_profile_chunk_key'
  ) then
    alter table document_fragments
      add constraint document_fragments_snapshot_profile_chunk_key
      unique (document_snapshot_id, embedding_profile_id, chunk_index);
  end if;
end $$;
