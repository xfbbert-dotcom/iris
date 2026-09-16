import { afterEach, describe, expect, test } from "vitest";
import { createPdSourceRef, type PdAssessment } from "../src/proactive-discussion/contracts.js";
import { createPdEvaluationWorker } from "../src/proactive-discussion/evaluation-worker.js";
import { hashLocalMessageText } from "../src/memory/local-message-source.js";
import { pdAssessment, PILOT_CHAT } from "./fixtures/proactive-discussion.js";
import { openPdDatabase, pdTestAt as at, preparePdDelivery } from "./helpers/proactive-discussion-postgres.js";

describe.skipIf(!process.env.IRIS_TEST_DATABASE_URL)("reviewed intervention pair PostgreSQL boundary", () => {
  let db: Awaited<ReturnType<typeof openPdDatabase>> | undefined;
  afterEach(async () => { await db?.close(); db = undefined; });

  test.each([
    { name: "accepted", outcome: "accepted", change: null },
    { name: "rejected", outcome: "rejected", change: null },
    { name: "rejected after context change", outcome: "rejected", change: "context" },
    { name: "rejected after catalog change", outcome: "rejected", change: "catalog" },
    { name: "rejected after issue change", outcome: "rejected", change: "issue" },
    { name: "rejected after source change", outcome: "rejected", change: "source" },
  ] as const)("$name pair persists reviewed issue prose or only a blocked audit", async ({ outcome, change }) => {
    db = await openPdDatabase();
    const { context: initialContext } = await preparePdDelivery(db);
    const text = "报价改成每人 12 万，仍招两人，预算还是 10 万。";
    const binding = { chatId: PILOT_CHAT, messageId: "m3", contentHash: hashLocalMessageText(text) };
    const source = { kind: "message" as const, binding, ref: createPdSourceRef({ kind: "message", binding }) };
    await db.pool.query(`INSERT INTO conversation_messages
      (id,provider,provider_message_id,chat_id,message_type,text,sender_open_id,sent_at,raw_event_idempotency_key)
      VALUES('feishu:m3','feishu','m3',$1,'text',$2,'test-human',$3,'m3')`, [PILOT_CHAT, text, at]);
    expect(await db.repository.register({ ...binding, policyVersion: 1, purpose: "assessment", at })).toBe("registered");
    const beforeState = await db.repository.readState(PILOT_CHAT);
    let expectedState = beforeState;
    let expectedIssues = (await db.pool.query("SELECT * FROM proactive_discussion_issues ORDER BY id")).rows;
    let expectedDeliveries = (await db.pool.query("SELECT * FROM proactive_discussion_deliveries ORDER BY id")).rows;
    const context = { ...initialContext, ...beforeState, policy: beforeState.policy!, triggerMessageId: "m3",
      sources: [...initialContext.sources, source], items: [...initialContext.items, { ref: source.ref, text }] };
    const candidate: PdAssessment = { ...pdAssessment(), issueRef: { kind: "existing", id: beforeState.issues[0]!.id },
      evidenceRefs: context.sources.map(item => item.ref), observation: "四人的总费用为 24 万。",
      reasoning: "预算缺口会导致项目失败。", suggestion: "立即取消招聘。",
      materialChange: { kind: "new_evidence", explanation: "报价从每人 8 万提高到 12 万。", evidenceRefs: [source.ref] } };
    const reviewed = { assessment: { ...candidate, observation: "两人各 12 万共 24 万，预算仍为 10 万。",
      reasoning: "预算相差 14 万，可能影响招聘计划。", suggestion: "建议先确认能否追加 14 万预算。",
      uncertainty: "qualified_inference" as const },
    draft: { text: "两人共 24 万，比预算多 14 万，可能影响招聘计划，建议先确认能否追加预算。", evidenceRefs: candidate.evidenceRefs } };
    let assessments = 0, renders = 0;
    const worker = createPdEvaluationWorker({ repository: db.repository, contextBuilder: { load: async () => context },
      model: { assess: async () => { assessments++; return candidate; }, render: async () => {
        renders++;
        if (change === "context") {
          await db!.pool.query(`INSERT INTO conversation_messages
            (id,provider,provider_message_id,chat_id,message_type,text,sender_open_id,sent_at,raw_event_idempotency_key)
            VALUES('feishu:m4','feishu','m4',$1,'text','明天下午再讨论。','test-human',$2,'m4')`, [PILOT_CHAT, at]);
        } else if (change === "catalog") {
          await db!.pool.query("UPDATE proactive_discussion_groups SET catalog_version=catalog_version+1 WHERE chat_id=$1", [PILOT_CHAT]);
        } else if (change === "issue") {
          await db!.pool.query("UPDATE proactive_discussion_issues SET version=version+1,last_reasoning='另一轮判断已更新。' WHERE id=$1", [beforeState.issues[0]!.id]);
        } else if (change === "source") {
          await db!.pool.query(`INSERT INTO conversation_message_deletion_tombstones
            (provider,provider_message_id,conversation_message_id,chat_id) VALUES('feishu','m1','feishu:m1',$1)`, [PILOT_CHAT]);
          // Isolate source protection from the independent context-version guard.
          context.contextVersion = (await db!.repository.readState(PILOT_CHAT)).contextVersion;
        }
        if (change !== null) {
          expectedState = await db!.repository.readState(PILOT_CHAT);
          expectedIssues = (await db!.pool.query("SELECT * FROM proactive_discussion_issues ORDER BY id")).rows;
          expectedDeliveries = (await db!.pool.query("SELECT * FROM proactive_discussion_deliveries ORDER BY id")).rows;
        }
        return outcome === "accepted" ? reviewed : null;
      } },
      membership: { isCurrentMember: async () => false }, reader: { listRecentMessages: async () => [] }, now: () => at, workerId: "reviewed-pair" });

    expect(await worker.runOnce()).toBe("processed");
    expect([assessments, renders]).toEqual([1, 1]);
    const evaluations = (await db.pool.query(`SELECT e.assessment,e.draft,e.outcome FROM proactive_discussion_evaluations e
      JOIN proactive_discussion_jobs j ON j.id=e.job_id WHERE j.message_id='m3'`)).rows;
    expect(evaluations).toEqual([{ assessment: outcome === "accepted" ? reviewed.assessment : candidate,
      draft: outcome === "accepted" ? reviewed.draft : null, outcome: outcome === "accepted" ? "prepared" : "blocked" }]);
    if (outcome === "accepted") {
      expect((await db.repository.readState(PILOT_CHAT)).issues).toEqual([expect.objectContaining({
        id: beforeState.issues[0]!.id, version: 2, basisVersion: 2,
        lastObservation: "两人各 12 万共 24 万，预算仍为 10 万。",
        lastReasoning: "预算相差 14 万，可能影响招聘计划。", lastSuggestion: "建议先确认能否追加 14 万预算。" })]);
      expect((await db.pool.query("SELECT trigger_message_id,text,state FROM proactive_discussion_deliveries ORDER BY trigger_message_id")).rows)
        .toEqual([{ trigger_message_id: "m2", text: "两人需要 16 万，建议先核对预算。", state: "cancelled" },
          { trigger_message_id: "m3", text: "两人共 24 万，比预算多 14 万，可能影响招聘计划，建议先确认能否追加预算。", state: "prepared" }]);
    } else {
      expect(await db.repository.readState(PILOT_CHAT)).toEqual(expectedState);
      expect((await db.pool.query("SELECT * FROM proactive_discussion_issues ORDER BY id")).rows).toEqual(expectedIssues);
      expect((await db.pool.query("SELECT * FROM proactive_discussion_deliveries ORDER BY id")).rows).toEqual(expectedDeliveries);
      expect((await db.pool.query("SELECT state,attempts,last_error FROM proactive_discussion_jobs WHERE message_id='m3'")).rows)
        .toEqual([{ state: "cancelled", attempts: 1, last_error: "assessment_or_draft_invalid" }]);
      expect(await worker.runOnce()).toBe("idle");
      expect([assessments, renders]).toEqual([1, 1]);
    }
  });
});
