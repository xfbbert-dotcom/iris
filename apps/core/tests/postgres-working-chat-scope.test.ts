import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { defaultMigrationsDir, runMigrations } from "../src/database/migrate.js";
import { WorkingChatScopeConflictError, WorkingChatScopeStaleError } from "../src/shared-chat/working-chat-scope.js";
import { createPostgresWorkingChatScopeRepository, lockSharedChatSources } from "../src/shared-chat/postgres-working-chat-scope-repository.js";

const databaseUrl = process.env.IRIS_TEST_DATABASE_URL?.trim();
const runIfDatabase = databaseUrl ? describe : describe.skip;
const at = new Date("2026-09-09T00:00:00Z");
const groups = [{ chatId: "group-a", name: "A" }, { chatId: "group-b", name: "B" }];
const replacement = { expectedVersion: 0, state: "active" as const, groups, updatedBy: "operator", at };
const binding = { scopeId: "pilot-working-chat", scopeVersion: 1, sourceChatId: "group-a",
  destinationChatId: "group-b", messageId: "message-1", contentHash: "a".repeat(64) };

runIfDatabase("versioned working chat scope with disposable PostgreSQL", () => {
  const schema = `working_chat_${randomUUID().replaceAll("-", "")}`;
  let administrativePool: pg.Pool;
  let pool: pg.Pool;
  beforeAll(async () => {
    administrativePool = new pg.Pool({ connectionString: databaseUrl });
    const client = await administrativePool.connect();
    try {
      await client.query(`CREATE SCHEMA ${schema}`);
      await client.query(`SET search_path TO ${schema}, public`);
      await runMigrations({ client, migrationsDir: defaultMigrationsDir() });
    } finally { client.release(); }
    pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema},public` });
  }, 60_000);
  afterAll(async () => {
    await pool?.end();
    if (administrativePool) {
      await administrativePool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await administrativePool.end();
    }
  });
  beforeEach(async () => {
    await pool.query("DELETE FROM answer_reply_chat_source_traces");
    await pool.query("DELETE FROM answer_reply_deliveries");
    await pool.query("DELETE FROM working_chat_scopes");
    await pool.query("DELETE FROM conversation_message_deletion_tombstones");
    await pool.query(`UPDATE runtime_control_state SET desired_global_enabled = true,
      disabled_group_ids = '{}', capabilities = capabilities || '{"readGroupContext":true,"replyWhenMentioned":true}'::jsonb`);
  });

  it("defaults closed, persists across repository instances, and resolves only named active members", async () => {
    const repo = createPostgresWorkingChatScopeRepository({ dataSource: pool });
    expect(await repo.get()).toBeUndefined();
    expect(await repo.resolveForChat("group-b")).toBeUndefined();
    expect(await repo.replace(replacement)).toEqual({ id: "pilot-working-chat", version: 1,
      state: "active", groups, updatedAt: at, updatedBy: "operator" });
    const restarted = createPostgresWorkingChatScopeRepository({ dataSource: pool });
    expect((await restarted.resolveForChat("group-b"))?.groups).toEqual(groups);
    expect(await restarted.resolveForChat("group-c")).toBeUndefined();
    expect(await restarted.validateExact(binding)).toBe(true);
  });

  it("rejects stale CAS and never revives old answer bindings after revoke and rejoin", async () => {
    const repo = createPostgresWorkingChatScopeRepository({ dataSource: pool });
    await repo.replace(replacement);
    await expect(repo.replace({ ...replacement, state: "revoked" })).rejects.toBeInstanceOf(WorkingChatScopeConflictError);
    expect((await repo.replace({ ...replacement, expectedVersion: 1, state: "revoked" })).version).toBe(2);
    expect(await repo.resolveForChat("group-a")).toBeUndefined();
    expect(await repo.validateExact(binding)).toBe(false);
    await repo.replace({ ...replacement, expectedVersion: 2 });
    expect(await repo.validateExact(binding)).toBe(false);
    expect(await repo.validateExact({ ...binding, scopeVersion: 3 })).toBe(true);
  });

  it("allows only one concurrent initial CAS", async () => {
    const repo = createPostgresWorkingChatScopeRepository({ dataSource: pool });
    const attempts = await Promise.allSettled([repo.replace(replacement), repo.replace(replacement)]);
    expect(attempts.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter(result => result.status === "rejected")).toHaveLength(1);
    expect((await repo.get())?.version).toBe(1);
  });

  it.each(["group-a", "group-b"])("rejects %s being disabled at the send boundary", async (chatId) => {
    const repo = createPostgresWorkingChatScopeRepository({ dataSource: pool });
    await repo.replace(replacement);
    await pool.query("UPDATE runtime_control_state SET disabled_group_ids = $1", [[chatId]]);
    await expect(withSendLocks(pool)).rejects.toBeInstanceOf(WorkingChatScopeStaleError);
  });

  it.each(["desired_global_enabled = false", "capabilities = capabilities || '{\"readGroupContext\":false}'::jsonb",
    "capabilities = capabilities || '{\"replyWhenMentioned\":false}'::jsonb"])("rejects current disabled runtime policy %s", async (update) => {
    const repo = createPostgresWorkingChatScopeRepository({ dataSource: pool });
    await repo.replace(replacement);
    await pool.query(`UPDATE runtime_control_state SET ${update}`);
    await expect(withSendLocks(pool)).rejects.toBeInstanceOf(WorkingChatScopeStaleError);
  });

  it("rejects tombstoned provider IDs even without a persisted message row", async () => {
    await createPostgresWorkingChatScopeRepository({ dataSource: pool }).replace(replacement);
    await pool.query(`INSERT INTO conversation_message_deletion_tombstones
      (provider, provider_message_id, conversation_message_id, chat_id)
      VALUES ('feishu', 'message-1', 'feishu:message-1', 'group-a')`);
    await expect(withSendLocks(pool)).rejects.toBeInstanceOf(WorkingChatScopeStaleError);
  });

  it("checks every exact binding and refuses destination substitution", async () => {
    await createPostgresWorkingChatScopeRepository({ dataSource: pool }).replace(replacement);
    await expect(withSendLocks(pool, [{ ...binding, sourceChatId: "group-c" }])).rejects.toBeInstanceOf(WorkingChatScopeStaleError);
    await expect(withSendLocks(pool, [binding, { ...binding, messageId: "message-2", scopeVersion: 2 }])).rejects.toBeInstanceOf(WorkingChatScopeStaleError);
    await expect(withSendLocks(pool, [binding], "group-c")).rejects.toBeInstanceOf(WorkingChatScopeStaleError);
    await expect(withSendLocks(pool)).resolves.toBeUndefined();
  });

  it.each(["sending", "reconciliation_required"])("refuses scope mutation while a related answer is %s", async (state) => {
    const repo = createPostgresWorkingChatScopeRepository({ dataSource: pool });
    await repo.replace(replacement);
    await insertDelivery(pool, state);
    await expect(repo.replace({ ...replacement, expectedVersion: 1, state: "revoked" })).rejects.toBeInstanceOf(WorkingChatScopeConflictError);
    expect((await repo.get())?.version).toBe(1);
  });

  it("linearizes an in-flight send before a concurrent revocation", async () => {
    const repo = createPostgresWorkingChatScopeRepository({ dataSource: pool });
    await repo.replace(replacement);
    const sender = await pool.connect();
    try {
      await sender.query("BEGIN");
      await lockSharedChatSources(sender, [binding], "group-b");
      const revoker = await pool.connect();
      const pid = (await revoker.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
      const concurrentRepo = createPostgresWorkingChatScopeRepository({ dataSource: {
        query: pool.query.bind(pool), connect: async () => revoker,
      } });
      const revoke = concurrentRepo.replace({ ...replacement, expectedVersion: 1, state: "revoked" });
      const observedRevoke = revoke.then(() => "unexpected success", error => error);
      await waitForPostgresLock(pool, pid);
      await insertDelivery(sender, "sending");
      await sender.query("COMMIT");
      expect(await observedRevoke).toBeInstanceOf(WorkingChatScopeConflictError);
      expect((await repo.get())?.state).toBe("active");
    } finally { await sender.query("ROLLBACK"); sender.release(); }
  });

  it("a completed revocation prevents a prepared answer from obtaining send locks", async () => {
    const repo = createPostgresWorkingChatScopeRepository({ dataSource: pool });
    await repo.replace(replacement);
    await insertDelivery(pool, "prepared");
    await repo.replace({ ...replacement, expectedVersion: 1, state: "revoked" });
    await expect(withSendLocks(pool)).rejects.toBeInstanceOf(WorkingChatScopeStaleError);
  });

  it("migration preserves legacy provenance and rejects invalid chat trace storage", async () => {
    await createPostgresWorkingChatScopeRepository({ dataSource: pool }).replace(replacement);
    await insertDelivery(pool, "prepared");
    expect((await pool.query("SELECT chat_provenance_version FROM answer_reply_deliveries")).rows)
      .toEqual([{ chat_provenance_version: null }]);
    await expect(pool.query("UPDATE answer_reply_chat_source_traces SET content_hash = 'bad' ")).rejects.toThrow();
    await expect(pool.query("UPDATE answer_reply_chat_source_traces SET source_chat_id = destination_chat_id")).rejects.toThrow();
    await expect(pool.query("UPDATE working_chat_scopes SET groups = '[{\"chatId\":\"a\",\"name\":\"A\"},{\"chatId\":\"a\",\"name\":\"B\"}]'::jsonb")).rejects.toThrow();
  });
});

async function withSendLocks(pool: pg.Pool, bindings = [binding], destinationChatId = "group-b"): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await lockSharedChatSources(client, bindings, destinationChatId);
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}

async function insertDelivery(queryable: Pick<pg.PoolClient, "query"> | pg.Pool, state: string): Promise<void> {
  await queryable.query(`INSERT INTO answer_reply_deliveries (
    id, provider, incoming_message_id, chat_id, reply_uuid, safe_notice_uuid, state,
    prepared_reply_text, rendered_reply_fingerprint, semantic_fingerprint, created_at, updated_at,
    attempt_count, last_send_started_at, reconciliation_required_at
  ) VALUES ('delivery-1','feishu','incoming-1','group-b','reply-1','safe-1',$1,
    CASE WHEN $1 = 'reconciliation_required' THEN NULL ELSE 'prepared reply' END,
    repeat('a',64),repeat('b',64),$2,$2,CASE WHEN $1 = 'prepared' THEN 0 ELSE 1 END,
    CASE WHEN $1 = 'prepared' THEN NULL ELSE $2::timestamptz END,
    CASE WHEN $1 = 'reconciliation_required' THEN $2::timestamptz ELSE NULL END)`, [state, at]);
  await queryable.query(`INSERT INTO answer_reply_chat_source_traces
    (delivery_id,trace_index,scope_id,scope_version,source_chat_id,destination_chat_id,message_id,content_hash)
    VALUES ('delivery-1',0,'pilot-working-chat',1,'group-a','group-b','message-1',repeat('a',64))`);
}

async function waitForPostgresLock(pool: pg.Pool, pid: number): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const activity = await pool.query<{ wait_event_type: string | null }>(
      "SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1", [pid],
    );
    if (activity.rows[0]?.wait_event_type === "Lock") return;
    await new Promise<void>(resolve => setTimeout(resolve, 10));
  }
  throw new Error("Concurrent scope revocation did not wait on the send transaction");
}
