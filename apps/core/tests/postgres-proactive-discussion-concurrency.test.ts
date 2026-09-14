import { afterEach, describe, expect, test, vi } from "vitest";
import { openPdDatabase, preparePdDelivery, pdTestAt as at, pdTestTime as time } from "./helpers/proactive-discussion-postgres.js";
import { PILOT_CHAT, pdContext, pdAssessment } from "./fixtures/proactive-discussion.js";
import { hashLocalMessageText } from "../src/memory/local-message-source.js";
import { createPdSourceRef } from "../src/proactive-discussion/contracts.js";
import { lockConversationMessageIngestScope } from "../src/conversation/conversation-message-replay-guard.js";
import { createPostgresProactiveDiscussionRepository } from "../src/proactive-discussion/postgres-repository.js";
import { createPostgresDocumentSourceGroupGrantRepository } from "../src/documents/postgres-document-source-group-grant-repository.js";
import type { TransactionClient } from "../src/conversation-state/postgres-conversation-state-repository.js";

// Each case migrates an isolated schema; SQL lock waits remain capped at 3s.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

describe.skipIf(!process.env.IRIS_TEST_DATABASE_URL)("proactive discussion final send PostgreSQL", () => {
  let db: Awaited<ReturnType<typeof openPdDatabase>>;
  afterEach(async () => { await db?.close(); });
  async function setup(historyOnly = false) {
    db = await openPdDatabase(); await preparePdDelivery(db, historyOnly);
    return (await db.repository.claimDelivery({ workerId: "sender", at, leaseUntil: time(60) }))!;
  }
  test("correction committed before final send invalidates the actual prepared delivery", async () => {
    const delivery = await setup();
    const before = await db.repository.readState(delivery.chatId);
    await db.pool.query("UPDATE conversation_messages SET text=$2 WHERE id=$1",
      ["feishu:m2", "已纠正，两人预算需要 16 万，先暂停招聘"]);
    expect(await db.repository.beginSend({ delivery, checkedContextVersion: before.contextVersion, at })).toBe("stale");
    expect((await db.pool.query("SELECT state FROM proactive_discussion_deliveries WHERE id=$1", [delivery.id])).rows[0].state).toBe("cancelled");
  });
  test("beginSend linearizes before later correction and never promises remote recall", async () => {
    const delivery = await setup(true);
    expect(await db.repository.beginSend({ delivery, checkedContextVersion: delivery.contextVersion, at })).toBe("sending");
    await db.pool.query("UPDATE conversation_messages SET text='后来纠正' WHERE id='feishu:m2'");
    await db.repository.finishSend({ delivery, outcome: "sent", replyMessageId: "receipt", at: time(1) });
    expect((await db.pool.query("SELECT state,reply_message_id FROM proactive_discussion_deliveries")).rows).toEqual([{ state: "sent", reply_message_id: "receipt" }]);
    expect((await db.pool.query("SELECT id FROM conversation_messages WHERE id='feishu:m1'")).rows).toEqual([]);
  });
  test.each(["policy", "runtime", "new-message", "pause", "deletion"])("%s committed before beginSend prevents speech", async gate => {
    const delivery = await setup();
    if (gate === "policy") await db.repository.setPolicy({ policy: { chatId: PILOT_CHAT, version: 2, enabled: false, operatorId: "operator" }, expectedVersion: 1, at });
    if (gate === "runtime") await db.pool.query("UPDATE runtime_control_state SET desired_global_enabled=false,revision=revision+1");
    if (gate === "new-message") await db.pool.query(`INSERT INTO conversation_messages
      (id,provider,provider_message_id,chat_id,message_type,text,sender_open_id,sent_at,raw_event_idempotency_key)
      VALUES('feishu:m3','feishu','m3',$1,'text','已经解决','human',$2,'m3')`, [PILOT_CHAT, at]);
    if (gate === "pause") await db.pool.query("UPDATE proactive_discussion_issues SET state='user_paused',version=version+1 WHERE id=$1", [delivery.issueId]);
    if (gate === "deletion") await db.pool.query("DELETE FROM conversation_messages WHERE id='feishu:m1'");
    expect(await db.repository.beginSend({ delivery, checkedContextVersion: delivery.contextVersion, at })).not.toBe("sending");
  });
  test("concurrent workers claim once; attempted delivery recovers unknown without retry", async () => {
    db = await openPdDatabase(); await preparePdDelivery(db);
    const claims = await Promise.all(["one", "two"].map(workerId => db.repository.claimDelivery({ workerId, at, leaseUntil: time(10) })));
    expect(claims.filter(Boolean)).toHaveLength(1);
    const delivery = claims.find(Boolean)!;
    expect(await db.repository.beginSend({ delivery, checkedContextVersion: delivery.contextVersion, at })).toBe("sending");
    expect(await db.repository.claimDelivery({ workerId: "restart", at: time(11), leaseUntil: time(20) })).toBeNull();
    expect((await db.repository.readState(PILOT_CHAT)).issues[0]!.hasUnknownDelivery).toBe(true);
    expect((await db.pool.query("SELECT state FROM proactive_discussion_deliveries")).rows[0].state).toBe("outcome_unknown");
  });
  test("expired prepared lease may be taken over but old owner cannot start or cancel", async () => {
    const old = await setup();
    const fresh = (await db.repository.claimDelivery({ workerId: "takeover", at: time(61), leaseUntil: time(90) }))!;
    expect(await db.repository.beginSend({ delivery: old, checkedContextVersion: old.contextVersion, at: time(62) })).toBe("stale");
    await db.repository.cancelDelivery({ delivery: old, reason: "old", at: time(62) });
    expect(await db.repository.beginSend({ delivery: fresh, checkedContextVersion: fresh.contextVersion, at: time(62) })).toBe("sending");
  });
  test("runtime revision changed even with enabled gates invalidates claim proof", async () => {
    const delivery = await setup();
    await db.pool.query("UPDATE runtime_control_state SET revision=revision+1");
    expect(await db.repository.beginSend({ delivery, checkedContextVersion: delivery.contextVersion, at })).toBe("blocked");
  });
  test("correction holds replay lock first; final send waits then observes its committed context", async () => {
    const delivery = await setup();
    const writer = await db.pool.connect();
    await writer.query("BEGIN");
    await lockConversationMessageIngestScope({ queryable: writer, conversationMessageId: "feishu:m2" });
    await writer.query("UPDATE conversation_messages SET text='已纠正，两人预算需要 16 万，先暂停招聘' WHERE id='feishu:m2'");
    const sending = db.repository.beginSend({ delivery, checkedContextVersion: delivery.contextVersion, at });
    try {
      let blocked = false;
      for (let step = 0; step < 100 && !blocked; step++) blocked = (await db.pool.query(`SELECT pid FROM pg_stat_activity
        WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT pg_advisory_xact_lock%'`)).rows.length > 0;
      expect(blocked).toBe(true);
    } finally { await writer.query("COMMIT"); writer.release(); }
    expect(await sending).toBe("stale");
    const jobs = (await db.pool.query("SELECT state,attempts FROM proactive_discussion_jobs")).rows;
    expect(jobs).toEqual([{ state: "pending", attempts: 1 }]);
    const next = await db.repository.claimEvaluation({ workerId: "reevaluate", at, leaseUntil: time(90) });
    expect(next?.attempt).toBe(2);
  });
  test("uncertain issue remains marked while an independent issue can still send", async () => {
    const delivery = await setup();
    await db.repository.beginSend({ delivery, checkedContextVersion: delivery.contextVersion, at });
    await db.repository.register({ chatId: PILOT_CHAT, messageId: "m1", contentHash: hashLocalMessageText(pdContext().items[0]!.text),
      policyVersion: 1, purpose: "assessment", at });
    const job = (await db.repository.claimEvaluation({ workerId: "next", at, leaseUntil: time(60) }))!;
    const state = await db.repository.readState(PILOT_CHAT);
    expect(state.issues[0]!.hasUnknownDelivery).toBe(true);
    const context = { ...pdContext(), ...state, triggerMessageId: "m1", policy: state.policy! };
    const nextAssessment = { ...pdAssessment(), issueRef: { kind: "new" as const, description: "独立的设备采购问题" } };
    expect(await db.repository.commitEvaluation({ job, context, assessment: nextAssessment,
      draft: { text: "请确认设备成本。", evidenceRefs: nextAssessment.evidenceRefs }, at })).toBe("prepared");
    const independent = (await db.repository.claimDelivery({ workerId: "independent", at, leaseUntil: time(60) }))!;
    expect(independent.issueId).not.toBe(delivery.issueId);
    expect(await db.repository.beginSend({ delivery: independent, checkedContextVersion: independent.contextVersion, at })).toBe("sending");
  });
  test("all versions of a sending or unknown issue reject even genuinely new evidence", async () => {
    const delivery = await setup();
    await db.repository.beginSend({ delivery, checkedContextVersion: delivery.contextVersion, at });
    await db.repository.finishSend({ delivery, outcome: "outcome_unknown", at });
    const text = "新增 20 万设备支出";
    await db.pool.query(`INSERT INTO conversation_messages
      (id,provider,provider_message_id,chat_id,message_type,text,sender_open_id,sent_at,raw_event_idempotency_key)
      VALUES('feishu:m3','feishu','m3',$1,'text',$2,'human',$3,'m3')`, [PILOT_CHAT, text, at]);
    await db.repository.register({ chatId: PILOT_CHAT, messageId: "m3", contentHash: hashLocalMessageText(text),
      policyVersion: 1, purpose: "assessment", at });
    const job = (await db.repository.claimEvaluation({ workerId: "next", at, leaseUntil: time(60) }))!;
    const state = await db.repository.readState(PILOT_CHAT);
    const binding = { chatId: PILOT_CHAT, messageId: "m3", contentHash: hashLocalMessageText(text) };
    const source = { kind: "message" as const, binding, ref: createPdSourceRef({ kind: "message", binding }) };
    const context = { ...pdContext(), ...state, triggerMessageId: "m3", policy: state.policy!, sources: [...pdContext().sources, source],
      items: [...pdContext().items, { ref: source.ref, text }] };
    const assessment = { ...pdAssessment(), issueRef: { kind: "existing" as const, id: delivery.issueId }, evidenceRefs: [source.ref],
      materialChange: { kind: "new_evidence" as const, explanation: "新增费用扩大预算缺口", evidenceRefs: [source.ref] } };
    expect(await db.repository.commitEvaluation({ job, context, assessment, draft: { text: "重新核对预算。", evidenceRefs: [source.ref] }, at })).toBe("blocked");
    expect((await db.pool.query("SELECT state FROM proactive_discussion_deliveries WHERE issue_id=$1", [delivery.issueId])).rows).toEqual([{ state: "outcome_unknown" }]);
  });
  test("missing runtime claim proof fails closed", async () => {
    const delivery = await setup();
    const { checkedRuntimeRevision: _proof, ...unproved } = delivery;
    expect(await db.repository.beginSend({ delivery: unproved as typeof delivery, checkedContextVersion: delivery.contextVersion, at })).toBe("blocked");
  });
  test.each(["revoke", "permission", "sync", "answering", "deleted", "new-snapshot"])("document %s is rechecked inside final send", async change => {
    db = await openPdDatabase(); await preparePdDelivery(db, false, change === "deleted" ? "ordinary" : "grant");
    const delivery = (await db.repository.claimDelivery({ workerId: "sender", at, leaseUntil: time(60) }))!;
    if (change === "revoke") await createPostgresDocumentSourceGroupGrantRepository({ dataSource: db.pool }).revoke({
      grantId: "grant-fixture", expectedVersion: 1, operationKey: "revoke", actorRef: "operator", at });
    if (change === "permission") await db.pool.query("UPDATE document_sources SET permission_state='stale' WHERE id='doc'");
    if (change === "sync") await db.pool.query("UPDATE document_sources SET sync_state='failed' WHERE id='doc'");
    if (change === "answering") await db.pool.query("UPDATE document_sources SET can_use_for_answering=false WHERE id='doc'");
    if (change === "deleted") await db.pool.query("DELETE FROM document_sources WHERE id='doc'");
    if (change === "new-snapshot") await db.pool.query(`INSERT INTO document_snapshots(id,document_source_id,source_uri,fetch_status,body_text,fetched_at,created_at)
      VALUES('new','doc','https://synthetic.feishu.cn/docx/test','succeeded','新版',$1,$1)`, [time(1)]);
    expect(await db.repository.beginSend({ delivery, checkedContextVersion: delivery.contextVersion, at })).toBe("blocked");
  });
  test("source lock prevents a new snapshot from committing between exact snapshot check and declaration", async () => {
    db = await openPdDatabase(); await preparePdDelivery(db, false, "ordinary");
    const delivery = (await db.repository.claimDelivery({ workerId: "sender", at, leaseUntil: time(60) }))!;
    let release!: () => void; let entered!: () => void;
    const reached = new Promise<void>(resolve => { entered = resolve; });
    const paused = new Promise<void>(resolve => { release = resolve; });
    const repository = createPostgresProactiveDiscussionRepository({ dataSource: { query: db.pool.query.bind(db.pool),
      connect: async () => {
        const client = await db.pool.connect();
        return { release: () => client.release(), query: async (sql: string, values?: unknown[]) => {
          const result = await client.query(sql, values);
          if (sql.includes("SELECT id FROM document_snapshots")) { entered(); await paused; }
          return result;
        } } as TransactionClient;
      } } });
    const sending = repository.beginSend({ delivery, checkedContextVersion: delivery.contextVersion, at });
    await reached;
    const writer = await db.pool.connect();
    let write: Promise<unknown> | undefined;
    try {
      const pid = (await writer.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      let settled = false;
      write = writer.query(`INSERT INTO document_snapshots(id,document_source_id,source_uri,fetch_status,body_text,fetched_at,created_at)
        VALUES('concurrent','doc','https://synthetic.feishu.cn/docx/test','succeeded','新版',$1,$1)`, [time(1)]).finally(() => { settled = true; });
      let blocked = false;
      for (let step = 0; step < 100 && !settled && !blocked; step++) {
        const activity = (await db.pool.query("SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1", [pid])).rows[0];
        blocked = activity?.wait_event_type === "Lock";
      }
      expect(blocked).toBe(true);
    } finally { release(); await sending; await write; writer.release(); }
    expect(await sending).toBe("sending");
  });
  test("snapshot insert holds source FK lock first; final send waits and rejects the newly committed version", async () => {
    db = await openPdDatabase(); await preparePdDelivery(db, false, "ordinary");
    const delivery = (await db.repository.claimDelivery({ workerId: "sender", at, leaseUntil: time(60) }))!;
    const writer = await db.pool.connect();
    await writer.query("BEGIN");
    await writer.query(`INSERT INTO document_snapshots(id,document_source_id,source_uri,fetch_status,body_text,fetched_at,created_at)
      VALUES('concurrent','doc','https://synthetic.feishu.cn/docx/test','succeeded','新版',$1,$1)`, [time(1)]);
    const sending = db.repository.beginSend({ delivery, checkedContextVersion: delivery.contextVersion, at });
    try {
      let blocked = false;
      for (let step = 0; step < 100 && !blocked; step++) blocked = (await db.pool.query(`SELECT pid FROM pg_stat_activity
        WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT * FROM document_sources%'`)).rows.length > 0;
      expect(blocked).toBe(true);
    } finally { await writer.query("COMMIT"); writer.release(); }
    expect(await sending).toBe("blocked");
  });
  test("transaction failure rolls back declaration; only a fresh successful declaration may send", async () => {
    const delivery = await setup();
    await db.pool.query(`CREATE FUNCTION reject_pd_send() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.state='sending' THEN RAISE EXCEPTION 'synthetic declaration failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER reject_pd_send BEFORE UPDATE ON proactive_discussion_deliveries FOR EACH ROW EXECUTE FUNCTION reject_pd_send()`);
    await expect(db.repository.beginSend({ delivery, checkedContextVersion: delivery.contextVersion, at })).rejects.toThrow("synthetic declaration failure");
    expect((await db.pool.query("SELECT state,attempted_at FROM proactive_discussion_deliveries")).rows[0]).toEqual({ state: "prepared", attempted_at: null });
    await db.pool.query("DROP TRIGGER reject_pd_send ON proactive_discussion_deliveries");
    expect(await db.repository.beginSend({ delivery, checkedContextVersion: delivery.contextVersion, at })).toBe("sending");
  });
  test.each(["sent", "not_sent"] as const)("trusted reconciliation %s persists operator evidence and never requeues", async outcome => {
    const delivery = await setup();
    await db.repository.beginSend({ delivery, checkedContextVersion: delivery.contextVersion, at });
    await db.repository.finishSend({ delivery, outcome: "outcome_unknown", at });
    const row = (await db.pool.query("SELECT version FROM proactive_discussion_deliveries")).rows[0];
    const input = { deliveryId: delivery.id, expectedVersion: Number(row.version), operatorId: "authenticated-operator",
      evidence: "synthetic operator receipt verification evidence", outcome, ...(outcome === "sent" ? { replyMessageId: "verified-receipt" } : {}), at };
    expect(await db.repository.reconcile(input)).toBe("applied");
    expect(await db.repository.reconcile(input)).toBe("conflict");
    expect(await db.repository.claimDelivery({ workerId: "later", at: time(70), leaseUntil: time(90) })).toBeNull();
    expect((await db.repository.readState(PILOT_CHAT)).issues[0]!.hasUnknownDelivery).toBe(false);
    const events = (await db.pool.query("SELECT payload FROM proactive_discussion_events WHERE entity_type='delivery' ORDER BY id DESC LIMIT 1")).rows;
    expect(JSON.parse(events[0].payload.last_error)).toEqual({ operatorId: input.operatorId, evidence: input.evidence, outcome });
  });
});
