import { afterEach, describe, expect, test } from "vitest";
import { openPdDatabase } from "./helpers/proactive-discussion-postgres.js";
import { PILOT_CHAT, pdContext } from "./fixtures/proactive-discussion.js";
import { hashLocalMessageText } from "../src/memory/local-message-source.js";
import { createPdSourceRef } from "../src/proactive-discussion/contracts.js";
import { createPostgresConversationMessageReplayGuard } from "../src/conversation/conversation-message-replay-guard.js";

const at = new Date("2026-09-14T00:00:00Z");
const time = (seconds: number) => new Date(at.getTime() + seconds * 1000);
type Database = Awaited<ReturnType<typeof openPdDatabase>>;

test("message bindings normalize only CRLF and source refs are canonical by binding", () => {
  expect(hashLocalMessageText("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  expect(hashLocalMessageText("a\r\nb")).toBe(hashLocalMessageText("a\nb"));
  expect(hashLocalMessageText(" a\nb")).not.toBe(hashLocalMessageText("a\nb"));
  const source = pdContext().sources[0]!;
  if (source.kind !== "message") throw new Error("expected message fixture");
  expect(createPdSourceRef({ kind: "message", binding: {
    contentHash: source.binding.contentHash, messageId: "m1", chatId: PILOT_CHAT,
  } })).toBe(source.ref);
  expect(createPdSourceRef({ kind: "message", binding: { ...source.binding, contentHash: "a".repeat(64) } })).not.toBe(source.ref);
  const document = { kind: "document" as const, binding: { documentSourceId: "doc", documentSnapshotId: "snapshot",
    crossGroupGrantId: "grant", crossGroupGrantVersion: 1, crossGroupGrantorGroupId: "owner", crossGroupGranteeGroupId: PILOT_CHAT } };
  expect(createPdSourceRef(document)).not.toBe(createPdSourceRef({ ...document, binding: { ...document.binding, crossGroupGrantVersion: 2 } }));
});

describe.skipIf(!process.env.IRIS_TEST_DATABASE_URL)("proactive discussion PostgreSQL foundation", () => {
  let db: Database | undefined;
  afterEach(async () => { await db?.close(); db = undefined; });
  async function open() { db = await openPdDatabase(); return db; }
  async function enabled() {
    const value = await open();
    await value.repository.setPolicy({ policy: { chatId: PILOT_CHAT, version: 1, enabled: true, operatorId: "test-operator" }, expectedVersion: 0, at });
    return value;
  }
  async function message(value: Database, id = "m1", text = "预算只有 10 万", chat = PILOT_CHAT) {
    await value.pool.query(`INSERT INTO conversation_messages
      (id,provider,provider_message_id,chat_id,message_type,text,sender_open_id,sent_at,raw_event_idempotency_key)
      VALUES ($1,'feishu',$2,$3,'text',$4,'test-human',$5,$2)`, [`feishu:${id}`, id, chat, text, at]);
  }
  const registration = (id = "m1", text = "预算只有 10 万") => ({
    chatId: PILOT_CHAT, messageId: id, contentHash: hashLocalMessageText(text), policyVersion: 1, purpose: "assessment" as const, at,
  });

  test("policy update uses CAS, starts absent and rejects unauthorized groups and invalid versions", async () => {
    const value = await open();
    expect(await value.repository.readState(PILOT_CHAT)).toEqual({ policy: null, contextVersion: 0, catalogVersion: 0, issues: [] });
    const input = { policy: { chatId: PILOT_CHAT, version: 1, enabled: false, operatorId: "test-operator" }, expectedVersion: 0, at };
    expect(await value.repository.setPolicy(input)).toBe("applied");
    expect(await value.repository.setPolicy(input)).toBe("conflict");
    expect((await value.repository.readState(PILOT_CHAT)).policy?.enabled).toBe(false);
    await expect(value.repository.setPolicy({ ...input, policy: { ...input.policy, chatId: "other" } })).rejects.toThrow();
    await expect(value.repository.setPolicy({ ...input, policy: { ...input.policy, version: 3 }, expectedVersion: 1 })).rejects.toThrow();
    const update = { ...input, policy: { ...input.policy, version: 2, enabled: true }, expectedVersion: 1 };
    expect((await Promise.all([value.repository.setPolicy(update), value.repository.setPolicy(update)])).sort()).toEqual(["applied", "conflict"]);
    expect((await value.pool.query("SELECT count(*) FROM proactive_discussion_events WHERE entity_type = 'policy'")).rows[0].count).toBe("2");
  });

  test("register is exact, duplicate-safe, disabled-safe and does not reacquire the outer replay lock", async () => {
    const value = await enabled();
    expect(await value.repository.register(registration())).toBe("blocked");
    await message(value);
    const guard = createPostgresConversationMessageReplayGuard({ dataSource: value.pool });
    expect(await guard.runUnlessDeleted({ identity: { provider: "feishu", providerMessageId: "m1", chatId: PILOT_CHAT },
      effect: () => value.repository.register(registration()) })).toEqual({ status: "active", value: "registered" });
    expect(await value.repository.register(registration())).toBe("duplicate");
    expect(await value.repository.register({ ...registration(), chatId: "other" })).toBe("blocked");
    expect(await value.repository.register({ ...registration(), policyVersion: 2 })).toBe("blocked");
    await value.pool.query("UPDATE conversation_messages SET text = '新预算' WHERE provider_message_id = 'm1'");
    expect(await value.repository.register(registration())).toBe("blocked");
    expect(await value.repository.register(registration("m1", "新预算"))).toBe("registered");
    await value.repository.setPolicy({ policy: { chatId: PILOT_CHAT, version: 2, enabled: false, operatorId: "test-operator" }, expectedVersion: 1, at });
    expect(await value.repository.register({ ...registration("m1", "新预算"), policyVersion: 2 })).toBe("blocked");
    expect(await value.repository.claimEvaluation({ workerId: "worker", at, leaseUntil: time(10) })).toBeNull();
    expect((await value.repository.getStatus()).pending).toBe(0);
  });

  test("context version tracks message identity, moves and tombstones atomically but not replay keys", async () => {
    const value = await enabled();
    const version = async (chat = PILOT_CHAT) => (await value.repository.readState(chat)).contextVersion;
    expect(await version()).toBe(1);
    await message(value);
    expect(await version()).toBe(2);
    await value.pool.query("UPDATE conversation_messages SET raw_event_idempotency_key = 'retry' WHERE provider_message_id = 'm1'");
    expect(await version()).toBe(2);
    await value.pool.query("UPDATE conversation_messages SET text = 'changed' WHERE provider_message_id = 'm1'");
    expect(await version()).toBe(3);
    await value.pool.query("UPDATE conversation_messages SET sender_open_id = 'test-human-2' WHERE provider_message_id = 'm1'");
    expect(await version()).toBe(4);
    await value.pool.query("UPDATE conversation_messages SET message_type = 'post' WHERE provider_message_id = 'm1'");
    expect(await version()).toBe(5);
    const eventsBeforeRollback = (await value.pool.query("SELECT count(*) FROM proactive_discussion_events")).rows[0].count;
    const client = await value.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("UPDATE conversation_messages SET text = 'rolled back' WHERE provider_message_id = 'm1'");
      expect((await client.query("SELECT context_version FROM proactive_discussion_groups WHERE chat_id = $1", [PILOT_CHAT])).rows[0].context_version).toBe("6");
      await client.query("ROLLBACK");
    } finally { client.release(); }
    expect(await version()).toBe(5);
    expect((await value.pool.query("SELECT count(*) FROM proactive_discussion_events")).rows[0].count).toBe(eventsBeforeRollback);
    await value.pool.query(`INSERT INTO proactive_discussion_policies (chat_id,version,enabled,operator_id,updated_at)
      VALUES ('test-other',1,false,'test-operator',$1)`, [at]);
    await value.pool.query("UPDATE conversation_messages SET chat_id = 'test-other' WHERE provider_message_id = 'm1'");
    expect(await version()).toBe(6);
    expect(await version("test-other")).toBe(2);
    await value.pool.query(`INSERT INTO conversation_message_deletion_tombstones
      (provider,provider_message_id,conversation_message_id,chat_id) VALUES ('feishu','m1','feishu:m1','test-other')`);
    expect(await version("test-other")).toBe(3);
    expect(await value.repository.register(registration("m1", "changed"))).toBe("blocked");
    await value.pool.query("DELETE FROM conversation_messages WHERE provider_message_id = 'm1'");
    expect(await version("test-other")).toBe(4);
    await message(value, "outside", "outside", "unregistered");
    expect(await version("unregistered")).toBe(0);
    expect((await value.pool.query("SELECT count(*) FROM proactive_discussion_groups")).rows[0].count).toBe("2");
  });

  test("tombstone prevents new work even while the stored message remains", async () => {
    const value = await enabled();
    await message(value);
    await value.pool.query(`INSERT INTO conversation_message_deletion_tombstones
      (provider,provider_message_id,conversation_message_id,chat_id) VALUES ('feishu','m1','feishu:m1',$1)`, [PILOT_CHAT]);
    expect(await value.repository.register(registration())).toBe("blocked");
  });

  test("feedback registration preserves the direct actor identity and purpose without applying feedback", async () => {
    const value = await enabled();
    await message(value);
    const feedback = { action: "pause" as const, replyMessageId: "reply-1", actorOpenId: "test-human" };
    expect(await value.repository.register({ ...registration(), purpose: "feedback" })).toBe("blocked");
    expect(await value.repository.register({ ...registration(), purpose: "feedback", feedback: { ...feedback, actorOpenId: "forged" } })).toBe("blocked");
    expect(await value.repository.register({ ...registration(), purpose: "feedback", feedback })).toBe("registered");
    expect(await value.repository.claimEvaluation({ workerId: "w", at, leaseUntil: time(10) })).toMatchObject({ purpose: "feedback", feedback });
    expect((await value.repository.readState(PILOT_CHAT)).issues).toEqual([]);
  });

  test("parallel claims are unique and expired lease tokens cannot settle replacement work", async () => {
    const value = await enabled();
    await message(value);
    await value.repository.register(registration());
    const claims = await Promise.all(Array.from({ length: 8 }, (_, i) => value.repository.claimEvaluation({ workerId: `w${i}`, at, leaseUntil: time(10) })));
    const claimed = claims.filter(item => item !== null);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.attempt).toBe(1);
    const replacement = await value.repository.claimEvaluation({ workerId: "replacement", at: time(11), leaseUntil: time(20) });
    expect(replacement?.attempt).toBe(2);
    expect(replacement?.leaseToken).not.toBe(claimed[0]?.leaseToken);
    await value.repository.failEvaluation({ job: claimed[0]!, reason: "old owner", retryable: false, at: time(12) });
    expect((await value.repository.getStatus()).deadLetter).toBe(0);
    await value.repository.failEvaluation({ job: replacement!, reason: "current owner", retryable: false, at: time(12) });
    expect(await value.repository.getStatus()).toMatchObject({ pending: 0, failed: 1, deadLetter: 1, unknown: 0 });
  });

  test("evaluation errors back off 1 then 5 seconds, stop after three attempts and remain auditable", async () => {
    const value = await enabled();
    await message(value);
    await value.repository.register(registration());
    for (const [index, second] of [0, 1, 6].entries()) {
      const job = await value.repository.claimEvaluation({ workerId: "worker", at: time(second), leaseUntil: time(second + 10) });
      expect(job?.attempt).toBe(index + 1);
      await value.repository.failEvaluation({ job: job!, reason: "model unavailable", retryable: true, at: time(second) });
      expect(await value.repository.claimEvaluation({ workerId: "early", at: time(second), leaseUntil: time(second + 10) })).toBeNull();
    }
    expect(await value.repository.claimEvaluation({ workerId: "late", at: time(100), leaseUntil: time(110) })).toBeNull();
    expect(await value.repository.getStatus()).toEqual({ pending: 0, failed: 1, deadLetter: 1, unknown: 0, lastSuccessAt: null });
    const events = await value.pool.query("SELECT operation FROM proactive_discussion_events WHERE entity_type = 'job'");
    expect(events.rows).toHaveLength(7);
    await expect(value.pool.query("DELETE FROM proactive_discussion_events")).rejects.toThrow(/append-only/iu);
    await expect(value.pool.query("UPDATE proactive_discussion_events SET operation = 'fake'")).rejects.toThrow(/append-only/iu);
  });

  test("schema preserves exact source facts, delivery identities and truthful sent receipts", async () => {
    const value = await enabled();
    await message(value);
    await value.repository.register(registration());
    const job = await value.repository.claimEvaluation({ workerId: "w", at, leaseUntil: time(10) });
    await value.pool.query(`INSERT INTO proactive_discussion_issues
      (id,chat_id,description,state,version,basis_version,last_observation,last_reasoning,last_suggestion,basis_sources)
      VALUES ('issue',$1,'budget','observing',1,1,'observation','reasoning','suggestion',$2::jsonb)`, [PILOT_CHAT, JSON.stringify(pdContext().sources)]);
    await value.pool.query(`INSERT INTO proactive_discussion_evaluations
      (id,job_id,attempt,chat_id,context_version,catalog_version,policy_version,assessment,draft)
      VALUES ('evaluation',$1,1,$2,2,1,1,'{}','null')`, [job!.id, PILOT_CHAT]);
    const insertDelivery = (id: string, basis = 1, uuid = "reply-uuid", state = "prepared", receipt: string | null = null, authorization = "policy") =>
      value.pool.query(`INSERT INTO proactive_discussion_deliveries
        (id,chat_id,issue_id,issue_version,basis_version,policy_version,context_version,trigger_message_id,text,reply_uuid,state,authorization_kind,reply_message_id)
        VALUES ($1,$2,'issue',1,$3,1,2,'m1','budget advice',$4,$5,$6,$7)`, [id, PILOT_CHAT, basis, uuid, state, authorization, receipt]);
    await insertDelivery("delivery");
    await expect(insertDelivery("duplicate-basis", 1, "other-uuid")).rejects.toMatchObject({ code: "23505" });
    await expect(insertDelivery("duplicate-uuid", 2)).rejects.toMatchObject({ code: "23505" });
    await expect(insertDelivery("false-approval", 2, "new-uuid", "prepared", null, "human_approved")).rejects.toMatchObject({ code: "23514" });
    await expect(insertDelivery("false-success", 2, "new-uuid", "sent")).rejects.toMatchObject({ code: "23514" });
    await expect(insertDelivery("blank-success", 2, "new-uuid", "sent", " ")).rejects.toMatchObject({ code: "23514" });
    const source = pdContext().sources[0]!;
    await value.pool.query(`INSERT INTO proactive_discussion_sources
      (evaluation_id,source_index,kind,ref,binding) VALUES ('evaluation',0,$1,$2,$3::jsonb)`, [source.kind, source.ref, JSON.stringify(source.binding)]);
    await value.pool.query(`INSERT INTO proactive_discussion_sources
      (delivery_id,source_index,kind,ref,binding) VALUES ('delivery',0,$1,$2,$3::jsonb)`, [source.kind, source.ref, JSON.stringify(source.binding)]);
    await expect(value.pool.query("DELETE FROM proactive_discussion_evaluations")).rejects.toThrow(/append-only/iu);
    await expect(value.pool.query("UPDATE proactive_discussion_evaluations SET assessment = '{}'::jsonb")).rejects.toThrow(/append-only/iu);
    await expect(value.pool.query("DELETE FROM proactive_discussion_sources")).rejects.toThrow(/append-only/iu);
    await expect(value.pool.query("UPDATE proactive_discussion_sources SET ref = 'changed'")).rejects.toThrow(/append-only/iu);
    expect((await value.repository.readState(PILOT_CHAT)).issues[0]).toMatchObject({ id: "issue", basisSources: pdContext().sources, hasUnknownDelivery: false });
  });

  test("catalog capacity degrades explicitly instead of returning a misleading partial catalog", async () => {
    const value = await enabled();
    await value.pool.query(`INSERT INTO proactive_discussion_issues
      (id,chat_id,description,state,version,basis_version,last_observation,last_reasoning,last_suggestion,basis_sources)
      SELECT 'issue-' || i,$1,'budget','observing',1,1,'observation','reasoning','suggestion','[]'::jsonb
      FROM generate_series(1,101) AS i`, [PILOT_CHAT]);
    await expect(value.repository.readState(PILOT_CHAT)).rejects.toMatchObject({ code: "proactive_discussion_catalog_degraded" });
  });

  test("three crashed evaluation leases become dead-letter and cannot retry forever", async () => {
    const value = await enabled();
    await message(value);
    await value.repository.register(registration());
    for (const second of [0, 11, 22]) {
      expect(await value.repository.claimEvaluation({ workerId: "crasher", at: time(second), leaseUntil: time(second + 10) })).not.toBeNull();
    }
    expect(await value.repository.claimEvaluation({ workerId: "fourth", at: time(33), leaseUntil: time(43) })).toBeNull();
    expect((await value.repository.getStatus()).deadLetter).toBe(1);
  });

  test("local answer traces preserve exact message bindings and reject later mutation", async () => {
    const value = await open();
    await value.pool.query(`INSERT INTO answer_reply_deliveries
      (id,provider,incoming_message_id,chat_id,reply_uuid,safe_notice_uuid,state,
       prepared_reply_text,rendered_reply_fingerprint,semantic_fingerprint,created_at,updated_at)
      VALUES ('answer','feishu','incoming',$1,'answer-uuid','notice-uuid','prepared',
        'answer',repeat('a',64),repeat('b',64),$2,$2)`, [PILOT_CHAT, at]);
    await value.pool.query(`INSERT INTO answer_reply_local_source_traces
      (delivery_id,trace_index,chat_id,message_id,content_hash) VALUES ('answer',0,$1,'m1',$2)`, [PILOT_CHAT, hashLocalMessageText("预算只有 10 万")]);
    await expect(value.pool.query(`INSERT INTO answer_reply_local_source_traces
      (delivery_id,trace_index,chat_id,message_id,content_hash) VALUES ('answer',0,$1,'m2',repeat('b',64))`, [PILOT_CHAT])).rejects.toMatchObject({ code: "23505" });
    await expect(value.pool.query("UPDATE answer_reply_local_source_traces SET message_id = 'changed'")).rejects.toThrow(/append-only/iu);
    await expect(value.pool.query("DELETE FROM answer_reply_local_source_traces")).rejects.toThrow(/append-only/iu);
  });
});
