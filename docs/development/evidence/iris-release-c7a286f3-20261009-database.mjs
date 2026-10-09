// Read-only release gate; no business message text, payloads or credentials leave the container.
import pg from 'pg';
const tables = ['proactive_discussion_policies','proactive_discussion_groups','proactive_discussion_jobs',
  'proactive_discussion_evaluations','proactive_discussion_issues','proactive_discussion_deliveries',
  'proactive_discussion_sources','proactive_discussion_events','answer_reply_local_source_traces'];
const client = new pg.Client({connectionString:process.env.DATABASE_URL,connectionTimeoutMillis:5000,
  options:'-c default_transaction_read_only=on'});
const report = {capturedAt:new Date().toISOString(),transaction:'repeatable-read/read-only'};
const assert = (value,code) => { if(!value) throw Error(code); };
try {
  await client.connect();
  await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await client.query("SET LOCAL statement_timeout='10s'");
  report.migrations=(await client.query('SELECT name,applied_at FROM schema_migrations ORDER BY name')).rows;
  assert(report.migrations.length===53,'migration_count');
  assert(report.migrations.slice(-2).map(x=>x.name).join(',')==='0059_proactive_discussion.sql,0060_proactive_discussion_prose_sources.sql','migration_names');
  report.tablePrivileges=(await client.query(`SELECT c.relname AS name,
    c.relowner=(SELECT relowner FROM pg_class WHERE oid='public.schema_migrations'::regclass) AS owner_matches_migrator,
    c.relowner<>(SELECT oid FROM pg_roles WHERE rolname=current_user) AS app_not_owner,
    has_table_privilege(current_user,c.oid,'SELECT') AS can_select,
    has_table_privilege(current_user,c.oid,'INSERT') AS can_insert,
    has_table_privilege(current_user,c.oid,'UPDATE') AS can_update,
    has_table_privilege(current_user,c.oid,'DELETE') AS can_delete
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=ANY($1::text[]) ORDER BY c.relname`,[tables])).rows;
  assert(report.tablePrivileges.length===tables.length && report.tablePrivileges.every(t=>Object.entries(t).every(([k,v])=>k==='name'||v===true)),'table_privileges');
  report.sequencePrivileges=(await client.query(`SELECT c.relname AS name,
    c.relowner=(SELECT relowner FROM pg_class WHERE oid='public.schema_migrations'::regclass) AS owner_matches_migrator,
    has_sequence_privilege(current_user,c.oid,'USAGE') AS can_use,
    has_sequence_privilege(current_user,c.oid,'SELECT') AS can_select
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind='S' AND c.relname LIKE 'proactive_discussion_%' ORDER BY c.relname`)).rows;
  assert(report.sequencePrivileges.map(t=>t.name).join(',')==='proactive_discussion_events_id_seq,proactive_discussion_sources_id_seq'
    && report.sequencePrivileges.every(t=>t.owner_matches_migrator&&t.can_use&&t.can_select),'sequence_privileges');
  report.appRole=(await client.query(`SELECT rolsuper AS superuser, has_schema_privilege(current_user,'public','CREATE') AS schema_create
    FROM pg_roles WHERE rolname=current_user`)).rows[0];
  assert(report.appRole.superuser===false && report.appRole.schema_create===false,'app_role');
  report.proseSourcesColumn=(await client.query(`SELECT data_type,is_nullable FROM information_schema.columns
    WHERE table_schema='public' AND table_name='proactive_discussion_issues' AND column_name='prose_sources'`)).rows;
  assert(report.proseSourcesColumn.length===1 && report.proseSourcesColumn[0].data_type==='jsonb','prose_column');
  report.domainCounts={};
  for(const table of tables){
    report.domainCounts[table]=(await client.query(`SELECT count(*)::int AS count FROM public.${table}`)).rows[0].count;
  }
  report.runtime=(await client.query(`SELECT revision,desired_global_enabled,capabilities->'proactiveSpeech' AS proactive_speech,capabilities->'replyWhenMentioned' AS reply_when_mentioned
    FROM runtime_control_state WHERE singleton_id=1`)).rows[0];
  assert(report.runtime.desired_global_enabled===false && report.runtime.proactive_speech===false,'runtime_not_disabled');
  report.jobs=(await client.query('SELECT state,count(*)::int AS n FROM proactive_discussion_jobs GROUP BY state ORDER BY state')).rows;
  report.deliveries=(await client.query('SELECT state,count(*)::int AS n FROM proactive_discussion_deliveries GROUP BY state ORDER BY state')).rows;
  report.answers=(await client.query('SELECT state,count(*)::int AS n FROM answer_reply_deliveries GROUP BY state ORDER BY state')).rows;
  report.policies=(await client.query('SELECT enabled,count(*)::int AS n FROM proactive_discussion_policies GROUP BY enabled ORDER BY enabled')).rows;
  assert(report.policies.every(x=>x.enabled===false),'policy_not_disabled');
  assert(report.jobs.every(x=>['completed','cancelled'].includes(x.state)),'pd_job_not_settled');
  assert(report.deliveries.every(x=>['sent','cancelled'].includes(x.state)),'pd_delivery_not_settled');
  await client.query('ROLLBACK');
  report.ok=true;
  console.log(JSON.stringify(report,null,2));
} catch(error){
  try {await client.query('ROLLBACK');} catch {}
  console.error(JSON.stringify({ok:false,code:typeof error?.code==='string'?error.code:error?.message??'database_release_gate_failed'}));
  process.exitCode=1;
} finally {await client.end();}
