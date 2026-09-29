import { afterEach, describe, expect, test, vi } from "vitest";
import { openPdDatabase, preparePdDelivery, pdTestAt as at, pdTestTime as time } from "./helpers/proactive-discussion-postgres.js";
import { pdContext, pdAssessment, pdSkipAssessment, pdReviewFieldChecks, PILOT_CHAT } from "./fixtures/proactive-discussion.js";
import { createPdContextBuilder } from "../src/proactive-discussion/context-builder.js";
import { createPdSourceVerifier } from "../src/proactive-discussion/source-verifier.js";
import { createPdModel, validatePdAssessment } from "./fixtures/proactive-discussion-prose-client.js";
import { createPdEvaluationWorker } from "../src/proactive-discussion/evaluation-worker.js";
import { createPdDeliveryWorker } from "../src/proactive-discussion/delivery-worker.js";
import { createPdSourceRef, type PdAssessment, type PdJob } from "../src/proactive-discussion/contracts.js";
import { hashLocalMessageText } from "../src/memory/local-message-source.js";
import type { FeishuChatHistoryMessage } from "../src/feishu/feishu-chat-history-reader.js";
import { buildApp, type BuildAppDependencies } from "../src/app.js";
import { createProactiveDiscussionRuntime, type PdRuntimeResources } from "../src/runtime/proactive-discussion-runtime.js";
import { createFeishuMessageEventProcessor } from "../src/conversation/feishu-message-event-processor.js";
import { createPostgresConversationMessageRepository } from "../src/conversation/postgres-conversation-message-repository.js";
import { createPostgresConversationMessageReplayGuard } from "../src/conversation/conversation-message-replay-guard.js";
import { InMemoryRawEventQueue } from "../src/events/in-memory-raw-event-queue.js";
import { createRawEventWorker } from "../src/events/raw-event-worker.js";
import { createFeishuMentionAnswerResponder } from "../src/conversation/feishu-mention-answer-responder.js";
import { createPostgresAnswerReplyRepository } from "../src/answer-replies/postgres-answer-reply-repository.js";
import { createAnswerReplyDeliveryService } from "../src/answer-replies/answer-reply-delivery-service.js";
import { createAnswerDraftOrchestrator } from "../src/agent/answer-draft-orchestrator.js";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
describe.skipIf(!process.env.IRIS_TEST_DATABASE_URL)("final review real PostgreSQL regressions", () => {
  let db: Awaited<ReturnType<typeof openPdDatabase>>;
  afterEach(async () => { await db?.close(); vi.unstubAllEnvs(); });
  async function setup() {
    db = await openPdDatabase();
    const live = pdContext().items.map((item, index) => ({ messageId: `m${index + 1}`, chatId: PILOT_CHAT,
      senderId: "human", text: item.text, sentAt: at }));
    let recent = live;
    const reader = { listRecentMessages: async () => recent,
      readMessagesByIds: async ({ messageIds }: { messageIds: string[] }) => live.filter(m => messageIds.includes(m.messageId)) };
    const verifier = createPdSourceVerifier({ reader, documents: { verify: async () => [] }, canReadGroup: () => true, canProactivelySpeak: () => true });
    const builder = createPdContextBuilder({ repository: db.repository, reader, sourceVerifier: verifier, canReadGroup: () => true,
      documents: () => ({ buildContext: async () => ({ allowedFragments: [], deniedFragments: [], liveChatMessages: [] }) }) as never });
    async function add(id: string, text: string, register = true) {
      const message = { messageId: id, chatId: PILOT_CHAT, senderId: "human", text, sentAt: at };
      live.push(message);
      await db.pool.query(`INSERT INTO conversation_messages(id,provider,provider_message_id,chat_id,message_type,text,sender_open_id,sent_at,raw_event_idempotency_key)
        VALUES($1,'feishu',$2,$3,'text',$4,'human',$5,$2)`, [`feishu:${id}`, id, PILOT_CHAT, text, at]);
      if (register) await db.repository.register({ chatId: PILOT_CHAT, messageId: id, contentHash: hashLocalMessageText(text), policyVersion: 1, purpose: "assessment", at });
      return message;
    }
    const claim = () => db.repository.claimEvaluation({ workerId: "test", at, leaseUntil: time(60) });
    return { live, reader, verifier, builder, add, claim, recent: (rows: FeishuChatHistoryMessage[]) => { recent = rows; } };
  }

  test.each(["original", "uncited", "other-issue"])("birth then later basis binds %s exposure in actual next payload and delivery, then excludes revoked prose", async revoked => {
    const h = await setup();
    const first = pdAssessment();
    if (revoked === "uncited") { first.evidenceRefs = first.evidenceRefs.slice(0, 1); first.materialChange.evidenceRefs = first.evidenceRefs; }
    await preparePdDelivery(db, false, undefined, first);
    // An uncited exposure affects derived text just as a cited birth premise can.
    const birth = (await db.pool.query("SELECT id FROM proactive_discussion_deliveries")).rows[0];
    const claimed = await db.repository.claimDelivery({ workerId: "send", at, leaseUntil: time(60) });
    expect(await db.repository.beginSend({ delivery: claimed!, checkedContextVersion: claimed!.contextVersion, at })).toBe("sending");
    await db.repository.finishSend({ delivery: claimed!, outcome: "sent", replyMessageId: "birth-reply", at });
    const c = await h.add("c", "新报价变成每人 9 万"); h.recent([c]);
    const job = (await h.claim())!;
    const context = (await h.builder.load(job))!;
    const issue = context.issues[0]!;
    const cRef = context.items[0]!.ref;
    const assessment: PdAssessment = { ...pdAssessment(), issueRef: { kind: "existing", id: issue.id }, evidenceRefs: [cRef],
      materialChange: { kind: "new_evidence", explanation: "报价增加", evidenceRefs: [cRef] } };
    if (revoked === "other-issue") {
      assessment.issueRef = { kind: "new", description: "依赖招聘预算的交付风险" };
      assessment.materialChange.kind = "new_issue";
    }
    const payloads: string[] = [];
    const model = createPdModel({ client: { complete: async messages => { payloads.push(messages[1]!.content); return JSON.stringify(assessment); } } });
    expect(await model.assess(context)).toEqual(assessment);
    expect(await db.repository.commitEvaluation({ job, context, assessment, draft: { text: "报价增加，建议核对总预算。", evidenceRefs: [cRef] }, at })).toBe("prepared");
    const next = (await db.pool.query("SELECT id FROM proactive_discussion_deliveries WHERE id<>$1", [birth.id])).rows[0];
    const nextDelivery = (await db.repository.readDelivery(next.id))!;
    expect(nextDelivery.sources.map(s => s.ref)).toEqual(expect.arrayContaining(pdContext().sources.map(s => s.ref)));
    const later = await h.add("later", "补充讨论"); h.recent([later]);
    const laterJob = (await h.claim())!;
    const laterContext = (await h.builder.load(laterJob))!;
    expect(laterContext.sources.map(s => s.ref)).toContain(pdContext().sources[0]!.ref);
    const captured: string[] = [];
    const skipModel = createPdModel({ client: { complete: async messages => { captured.push(messages[1]!.content); return JSON.stringify(pdSkipAssessment()); } } });
    await skipModel.assess(laterContext);
    expect(captured[0]).toContain("招聘预算不足");
    const removed = revoked === "original" ? "m1" : "m2";
    h.live.splice(h.live.findIndex(m => m.messageId === removed), 1);
    const afterRevocation = (await h.builder.load(laterJob))!;
    await skipModel.assess(afterRevocation);
    expect(captured[1]).not.toContain("招聘预算不足");
    expect(afterRevocation.issues).toEqual([]);
  });

  test("unrelated context cancels a never-attempted draft, same premises reassess to exactly one first send", async () => {
    const h = await setup(); await preparePdDelivery(db);
    const issueId = (await db.repository.readState(PILOT_CHAT)).issues[0]!.id;
    await h.add("unrelated", "下午会议改到三点", false);
    const sends: string[] = [];
    const delivery = createPdDeliveryWorker({ repository: db.repository, reader: h.reader, sourceVerifier: h.verifier,
      replier: { replyText: async input => { sends.push(input.text); return { replyMessageId: "first-receipt" }; } }, now: () => at, workerId: "send" });
    expect(await delivery.runOnce()).toBe("processed"); expect(sends).toEqual([]);
    const stale = (await db.pool.query("SELECT state,attempted_at,last_error FROM proactive_discussion_deliveries")).rows[0];
    expect(stale).toMatchObject({ state: "cancelled", attempted_at: null, last_error: "context_stale" });
    const model = createPdModel({ client: { complete: async (messages, options) => {
      const kind = options?.responseFormat?.json_schema.name;
      if (kind === "iris_proactive_discussion_generated_pair") {
        const target = JSON.parse(messages[1]!.content).target;
        return JSON.stringify({ assessment: { ...pdAssessment(), ...target,
          materialChange: { ...target.materialChange, explanation: "此前草稿未曾尝试发送，原矛盾仍成立" } },
        draft: { text: "两人需要 16 万，建议核对预算。", evidenceRefs: pdAssessment().evidenceRefs } });
      }
      if (kind === "iris_proactive_discussion_scope_review") return JSON.stringify({ fieldChecks: pdReviewFieldChecks(), supported: true, reason: "预算依据未变",
        requiredNumbers: [], adviceQuote: "建议核对预算。" });
      return JSON.stringify({ ...pdAssessment(), issueRef: { kind: "existing", id: issueId },
        materialChange: { kind: "unattempted_first", explanation: "此前草稿未曾尝试发送，原矛盾仍成立", evidenceRefs: pdAssessment().evidenceRefs } });
    } } });
    const worker = createPdEvaluationWorker({ repository: db.repository, contextBuilder: h.builder, reader: h.reader, model,
      membership: { isCurrentMember: async () => true }, now: () => at, workerId: "eval" });
    expect(await worker.runOnce()).toBe("processed");
    expect(await delivery.runOnce()).toBe("processed"); expect(await delivery.runOnce()).toBe("idle");
    expect(sends).toHaveLength(1);
    expect((await db.repository.readState(PILOT_CHAT)).issues.map(i => i.id)).toEqual([issueId]);
    expect((await db.pool.query("SELECT state FROM proactive_discussion_deliveries ORDER BY basis_version")).rows).toEqual([{ state: "cancelled" }, { state: "sent" }]);
  });

  test.each(["prepared", "sent", "unknown", "attempted-not-sent", "other-cancellation", "pause-resume", "resolved-reopened"])("caller cannot forge first-intervention eligibility after %s", async mode => {
    const h = await setup(); await preparePdDelivery(db);
    const delivery = (await db.repository.claimDelivery({ workerId: "send", at, leaseUntil: time(60) }))!;
    if (["sent", "unknown", "attempted-not-sent"].includes(mode)) {
      await db.repository.beginSend({ delivery, checkedContextVersion: delivery.contextVersion, at });
      await db.repository.finishSend({ delivery, outcome: mode === "sent" ? "sent" : "outcome_unknown", ...(mode === "sent" ? { replyMessageId: "sent" } : {}), at });
      if (mode === "attempted-not-sent") {
        const saved = (await db.repository.readDelivery(delivery.id))!;
        await db.repository.reconcile({ deliveryId: delivery.id, expectedVersion: saved.version, operatorId: "test", outcome: "not_sent", evidence: "local synthetic declaration", at });
      }
    } else if (mode !== "prepared") {
      await db.repository.cancelDelivery({ delivery, reason: mode === "other-cancellation" ? "pre_send_check_failed" : "context_stale", at });
      if (mode !== "other-cancellation") {
        await db.pool.query("UPDATE proactive_discussion_issues SET state=$1 WHERE id=$2", [mode === "pause-resume" ? "user_paused" : "resolved", delivery.issueId]);
        await db.pool.query("UPDATE proactive_discussion_issues SET state='observing' WHERE id=$1", [delivery.issueId]);
      }
    }
    await h.add("retry", "仍然使用原预算");
    const job = (await h.claim())!;
    const context = (await h.builder.load(job))!;
    expect(context.issues[0]!.canReassessUnattempted).toBe(false);
    const assessment: PdAssessment = { ...pdAssessment(), issueRef: { kind: "existing", id: delivery.issueId },
      materialChange: { kind: "unattempted_first", explanation: "伪造首次资格", evidenceRefs: pdAssessment().evidenceRefs } };
    expect(() => validatePdAssessment(assessment, context)).toThrow();
    context.issues[0]!.canReassessUnattempted = true;
    expect(await db.repository.commitEvaluation({ job, context, assessment, draft: { text: "不应发送", evidenceRefs: assessment.evidenceRefs }, at })).toBe("blocked");
    expect((await db.pool.query("SELECT count(*)::int AS n FROM proactive_discussion_deliveries")).rows[0].n).toBe(1);
  });

  test("legacy unknown prose proof preserves identity and blocks new admission without exposing old text", async () => {
    const h = await setup(); await preparePdDelivery(db);
    await db.pool.query("UPDATE proactive_discussion_issues SET prose_sources=NULL");
    await h.add("later", "另一个新问题");
    const job = (await h.claim())!, context = (await h.builder.load(job))!;
    expect((await db.repository.readState(PILOT_CHAT)).issues).toHaveLength(1);
    expect(context.issues).toEqual([]);
    expect(await db.repository.commitEvaluation({ job, context, assessment: pdAssessment(),
      draft: { text: "不应绕过隐藏问题", evidenceRefs: pdAssessment().evidenceRefs }, at })).toBe("blocked");
  });

  test("owned lease renewal cannot revive expiry or an old owner after reassignment", async () => {
    const h = await setup(); await preparePdDelivery(db);
    await h.add("lease", "租约检查"); const job = (await h.claim())!;
    expect(await db.repository.renewEvaluation({ job, at: time(40), leaseUntil: time(100) })).toBe(true);
    expect(await db.repository.claimEvaluation({ workerId: "competitor", at: time(70), leaseUntil: time(130) })).toBeNull();
    expect(await db.repository.renewEvaluation({ job, at: time(100), leaseUntil: time(160) })).toBe(false);
    const successor = (await db.repository.claimEvaluation({ workerId: "successor", at: time(100), leaseUntil: time(160) }))!;
    expect(successor.leaseToken).not.toBe(job.leaseToken);
    expect(await db.repository.renewEvaluation({ job, at: time(101), leaseUntil: time(161) })).toBe(false);
    expect(await db.repository.renewEvaluation({ job: successor, at: time(101), leaseUntil: time(161) })).toBe(true);
  });

  test.each(["slow-success", "ownership-loss", "shutdown", "loss-during-prose"])("actual model pipeline and durable lease: %s", async mode => {
    const h = await setup();
    await db.repository.setPolicy({ policy: pdContext().policy, expectedVersion: 0, at });
    await db.pool.query(`UPDATE runtime_control_state SET desired_global_enabled=true,
      capabilities=jsonb_set(jsonb_set(capabilities,'{readGroupContext}','true'),'{proactiveSpeech}','true')`);
    h.live.splice(1, 1);
    await h.add("m2", pdContext().items[1]!.text);
    let seconds = 0, stopping = false, calls = 0, cancelled = false;
    let tick: () => Promise<void> = async () => undefined;
    const model = createPdModel({ client: { complete: async (_messages, options) => {
      calls++;
      if (mode === "ownership-loss" || (mode === "loss-during-prose" && calls === 2)) {
        seconds += 61;
        await db.repository.claimEvaluation({ workerId: "new-owner", at: time(seconds), leaseUntil: time(seconds + 60) });
      } else if (mode === "shutdown") stopping = true;
      else seconds += 25;
      await tick();
      const name = options?.responseFormat?.json_schema.name;
      if (name === "iris_proactive_discussion_generated_pair") return JSON.stringify({ assessment: pdAssessment(),
        draft: { text: "先核对预算。", evidenceRefs: pdAssessment().evidenceRefs } });
      if (name === "iris_proactive_discussion_scope_review") return JSON.stringify({ fieldChecks: pdReviewFieldChecks(), supported: true, reason: "有依据",
        requiredNumbers: [], adviceQuote: "先核对预算。" });
      return JSON.stringify(pdAssessment());
    } } });
    const worker = createPdEvaluationWorker({ repository: db.repository, contextBuilder: h.builder, reader: h.reader, model,
      membership: { isCurrentMember: async () => true }, now: () => time(seconds), workerId: "slow", isStopping: () => stopping,
      scheduleRenewal: (callback: () => Promise<void>) => { tick = callback; return () => { cancelled = true; }; } });
    expect(await worker.runOnce()).toBe(mode === "slow-success" ? "processed" : "failed");
    expect(calls).toBe(mode === "slow-success" ? 3 : mode === "loss-during-prose" ? 2 : 1);
    expect((await db.pool.query("SELECT state FROM proactive_discussion_deliveries")).rows)
      .toEqual(mode === "slow-success" ? [{ state: "prepared" }] : []);
    expect(cancelled).toBe(true);
    if (mode === "slow-success") {
      expect(seconds).toBe(75);
      expect((await db.pool.query("SELECT attempts,state FROM proactive_discussion_jobs")).rows).toEqual([{ attempts: 1, state: "completed" }]);
    }
  });

  test("actual app registrar retries queued ordinary and direct-stop events during delayed successful startup", async () => {
    const h = await setup(); await preparePdDelivery(db);
    const birth = (await db.repository.claimDelivery({ workerId: "send", at, leaseUntil: time(60) }))!;
    await db.repository.beginSend({ delivery: birth, checkedContextVersion: birth.contextVersion, at });
    await db.repository.finishSend({ delivery: birth, outcome: "sent", replyMessageId: "birth-reply", at });
    const queue = new InMemoryRawEventQueue();
    await db.pool.query("UPDATE runtime_control_state SET capabilities=jsonb_set(capabilities,'{replyWhenMentioned}','true')");
    for (const [id, text, parent] of [["ordinary", "明天继续核对", undefined], ["stop", "不再跟进这件事", "birth-reply"], ["qa", "@iris 你好", undefined]]) {
      h.live.push({ messageId: id!, text: text!, chatId: PILOT_CHAT, senderId: "human", sentAt: at, ...(parent ? { parentMessageId: parent } : {}) } as FeishuChatHistoryMessage);
      await queue.enqueue({ idempotencyKey: `raw:${id}`, provider: "feishu", eventType: "im.message.receive_v1", receivedAt: at, attempts: 0,
        rawBody: { event: { sender: { sender_type: "user", sender_id: { open_id: "human" } }, message: { message_id: id,
          chat_id: PILOT_CHAT, message_type: "text", content: JSON.stringify({ text }), create_time: String(at.getTime()),
          ...(parent ? { parent_id: parent } : {}), mentions: id === "qa" ? [{ key: "@iris", id: { open_id: "iris" } }] : [] } } } });
    }
    let release!: (resources: PdRuntimeResources) => void;
    const pending = new Promise<PdRuntimeResources>(resolve => { release = resolve; });
    const runtime = createProactiveDiscussionRuntime({ env: { IRIS_PROACTIVE_DISCUSSION_ENABLED: "true",
      IRIS_PROACTIVE_DISCUSSION_GROUP_IDS: PILOT_CHAT, IRIS_PROACTIVE_DISCUSSION_POLL_INTERVAL_MS: "60000" },
      createResources: async () => pending, now: () => at });
    let raw!: ReturnType<typeof createRawEventWorker>, first!: ReturnType<ReturnType<typeof createRawEventWorker>["processBatch"]>;
    const ordinaryReplies: string[] = [];
    const replier = { replyText: async (input: { text: string }) => { ordinaryReplies.push(input.text); return { replyMessageId: "qa-reply" }; } };
    const responder = createFeishuMentionAnswerResponder({ botOpenId: "iris", replier,
      answerDraftOrchestrator: createAnswerDraftOrchestrator({
        contextBuilder: { buildContext: async () => ({ promptContext: "", allowedFragments: [], deniedDocumentIds: [], retrievedFragmentCount: 0, usedGroupMemories: [] }) },
        planner: { plan: async () => { throw new Error("standalone greeting must not plan retrieval"); } },
        renderer: { render: async () => { throw new Error("standalone greeting must not render evidence"); } },
        model: { generateAnswerDraft: async () => ({ answerText: "你好，可以一起核对。" }) } }),
      answerReplyDeliveryService: createAnswerReplyDeliveryService({ repository: createPostgresAnswerReplyRepository({ dataSource: db.pool }),
        replier, verifier: { verify: async () => [] }, now: () => at }), now: () => at });
    vi.stubEnv("IRIS_PROACTIVE_DISCUSSION_ENABLED", "true"); vi.stubEnv("IRIS_PROACTIVE_DISCUSSION_GROUP_IDS", PILOT_CHAT);
    const app = await buildApp({ createProactiveDiscussionRuntime: () => runtime, createAnswerDraftRuntime: () => undefined,
      createDocumentSyncRuntime: () => undefined, createReindexWorkerRuntime: () => undefined,
      createEventWorkerRuntime: input => {
        raw = createRawEventWorker({ queue, processor: createFeishuMessageEventProcessor({
          messages: createPostgresConversationMessageRepository({ queryable: db.pool }),
          messageReplayGuard: createPostgresConversationMessageReplayGuard({ dataSource: db.pool }),
          proactiveDiscussionRegistrar: input!.proactiveDiscussionRegistrar, proactiveDiscussionBotOpenId: "iris",
          mentionAnswerResponder: responder,
        }) });
        return { start() { first = raw.processBatch({ limit: 3 }); }, close: async () => undefined } as never;
      } } as BuildAppDependencies);
    try {
      expect((await first).map(r => r.status)).toEqual(["failed", "failed", "failed"]);
      expect(await queue.getPendingCount()).toBe(3);
      expect(ordinaryReplies).toEqual(["你好，可以一起核对。"]);
      release({ repository: db.repository, botOpenId: "iris", reader: h.reader, contextBuilder: h.builder,
        sourceVerifier: h.verifier, model: { assess: async () => pdSkipAssessment(), render: async () => null },
        replier: { replyText: async () => { throw new Error("must not send"); } }, membership: { isCurrentMember: async () => true }, close: async () => undefined });
      await runtime.start();
      expect((await raw.processBatch({ limit: 3 })).map(r => r.status)).toEqual(["processed", "processed", "processed"]);
      expect(ordinaryReplies).toEqual(["你好，可以一起核对。"]);
      expect(await queue.getPendingCount()).toBe(0);
      expect((await db.pool.query("SELECT message_id,purpose FROM proactive_discussion_jobs WHERE message_id IN ('ordinary','stop') ORDER BY message_id")).rows)
        .toEqual([{ message_id: "ordinary", purpose: "assessment" }, { message_id: "stop", purpose: "feedback" }]);
      const worker = createPdEvaluationWorker({ repository: db.repository, reader: h.reader, contextBuilder: h.builder,
        model: { assess: async () => pdSkipAssessment(), render: async () => null }, membership: { isCurrentMember: async () => true }, now: () => at, workerId: "startup" });
      await worker.runOnce(); await worker.runOnce();
      expect((await db.repository.readState(PILOT_CHAT)).issues[0]!.state).toBe("user_paused");
    } finally { release({ close: async () => undefined } as PdRuntimeResources); await app.close(); }
  });
});
