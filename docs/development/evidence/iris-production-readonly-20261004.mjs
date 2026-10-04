// Run only inside the existing Core container after explicit read-only authorization.
// Does not import the application, call providers, read message bodies, or mutate runtime.
import pg from "pg";

const pilot = "oc_637a9aca45f01943477f4e17f1fc5b9a";
const names = ["schema_migrations", "runtime_control_state", "proactive_discussion_policies",
  "proactive_discussion_jobs", "proactive_discussion_deliveries", "answer_reply_deliveries"];
const client = new pg.Client({ connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 5000, options: "-c default_transaction_read_only=on" });
const report = { capturedAt: new Date().toISOString(), scope: "authorized_readonly_original_pilot" };
try {
  await client.connect();
  await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
  await client.query("SET LOCAL statement_timeout = '5s'");
  await client.query("SET LOCAL lock_timeout = '1s'");
  const tx = (await client.query("SELECT current_setting('transaction_read_only') AS read_only, current_schema() AS schema")).rows[0];
  if (tx.read_only !== "on" || tx.schema !== "public") throw new Error("unexpected_readonly_schema");
  report.transaction = tx;
  report.tables = (await client.query("SELECT name, to_regclass('public.' || name) IS NOT NULL AS present FROM unnest($1::text[]) AS name", [names])).rows;
  const columns = (await client.query("SELECT table_name, column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=ANY($1::text[])", [names])).rows;
  const available = (table, required) => report.tables.some(t => t.name === table && t.present) &&
    required.every(column => columns.some(c => c.table_name === table && c.column_name === column));
  report.migrations = available("schema_migrations", ["name", "applied_at"])
    ? (await client.query("SELECT name, applied_at FROM public.schema_migrations ORDER BY name")).rows
    : { unavailable: "schema_missing_or_incompatible" };
  report.durableControl = available("runtime_control_state", ["singleton_id", "revision", "desired_global_enabled", "disabled_group_ids", "capabilities"])
    ? (await client.query("SELECT revision, desired_global_enabled, $1=ANY(disabled_group_ids) AS pilot_disabled, capabilities->'readGroupContext' AS read_group_context, capabilities->'replyWhenMentioned' AS reply_when_mentioned, capabilities->'proactiveSpeech' AS proactive_speech FROM public.runtime_control_state WHERE singleton_id=1", [pilot])).rows
    : { unavailable: "schema_missing_or_incompatible" };
  report.policy = available("proactive_discussion_policies", ["chat_id", "version", "enabled"])
    ? (await client.query("SELECT version, enabled FROM public.proactive_discussion_policies WHERE chat_id=$1", [pilot])).rows
    : { unavailable: "schema_missing_or_incompatible" };
  report.queues = {};
  for (const table of ["proactive_discussion_jobs", "proactive_discussion_deliveries", "answer_reply_deliveries"]) {
    report.queues[table] = available(table, ["chat_id", "state"])
      ? (await client.query(`SELECT state, count(*)::int AS count FROM public.${table} WHERE chat_id=$1 GROUP BY state ORDER BY state`, [pilot])).rows
      : { unavailable: "schema_missing_or_incompatible" };
  }
  report.answerReplyHealth = available("answer_reply_deliveries", ["chat_id", "state", "safe_notice_sent_at"])
    ? (await client.query("SELECT count(*) FILTER (WHERE state IN ('prepared','sending'))::int AS unresolved_count, count(*) FILTER (WHERE state IN ('permission_blocked','reconciliation_required','not_sent_reconciled') AND safe_notice_sent_at IS NULL)::int AS pending_safe_notice_count, count(*) FILTER (WHERE state='reconciliation_required')::int AS reconciliation_required_count FROM public.answer_reply_deliveries WHERE chat_id=$1", [pilot])).rows
    : { unavailable: "schema_missing_or_incompatible" };
  // ROLLBACK also ends a successful read-only snapshot; no application state is written.
  await client.query("ROLLBACK");
  report.liveRuntime = { verified: false, reason: "status_GET_can_install_durable_snapshot_into_live_controller; not_called" };
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  try { await client.query("ROLLBACK"); } catch {}
  console.log(JSON.stringify({ capturedAt: report.capturedAt, failed: true,
    code: typeof error?.code === "string" ? error.code : "readonly_probe_failed" }));
  process.exitCode = 1;
} finally {
  await client.end();
}
