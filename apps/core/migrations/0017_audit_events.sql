create table audit_events (
  id bigserial primary key,
  payload jsonb not null,
  recorded_at timestamptz not null,
  constraint audit_events_payload_is_object check (jsonb_typeof(payload) = 'object')
);

create index audit_events_recent_idx
  on audit_events (recorded_at desc, id desc);

create table audit_log_metadata (
  singleton boolean primary key default true,
  dropped_event_count bigint not null default 0,
  constraint audit_log_metadata_singleton check (singleton),
  constraint audit_log_metadata_nonnegative_dropped check (dropped_event_count >= 0)
);

insert into audit_log_metadata (singleton, dropped_event_count)
values (true, 0)
on conflict (singleton) do nothing;
