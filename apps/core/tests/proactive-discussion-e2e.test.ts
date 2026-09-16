import { afterEach, describe, expect, test, vi } from "vitest";
import { openPdDatabase, pdTestAt as at } from "./helpers/proactive-discussion-postgres.js";
import { pdContext, pdAssessment, pdSkipAssessment, PILOT_CHAT } from "./fixtures/proactive-discussion.js";
import type { PdModel } from "../src/proactive-discussion/model.js";
import { createPdRegistrar } from "../src/proactive-discussion/registrar.js";
import { createPdContextBuilder } from "../src/proactive-discussion/context-builder.js";
import { createPdSourceVerifier } from "../src/proactive-discussion/source-verifier.js";
import { createPdEvaluationWorker } from "../src/proactive-discussion/evaluation-worker.js";
import { createPdDeliveryWorker } from "../src/proactive-discussion/delivery-worker.js";
import { createFeishuMessageEventProcessor } from "../src/conversation/feishu-message-event-processor.js";
import { createPostgresConversationMessageRepository } from "../src/conversation/postgres-conversation-message-repository.js";
import { createPostgresConversationMessageReplayGuard } from "../src/conversation/conversation-message-replay-guard.js";
import { createAssistantConversationContextProvider } from "../src/memory/assistant-conversation-context.js";
import { createPdReceiptProvider } from "../src/proactive-discussion/receipt-provider.js";
import { createLocalMessageSourceVerifier } from "../src/memory/local-message-source.js";
import { createFeishuLiveChatContextProvider } from "../src/memory/live-chat-context-provider.js";
import { createDocumentRetrievalContextBuilder } from "../src/memory/document-retrieval-context.js";
import { createAnswerDraftOrchestrator } from "../src/agent/answer-draft-orchestrator.js";
import { createFeishuMentionAnswerResponder } from "../src/conversation/feishu-mention-answer-responder.js";
import { createPostgresAnswerReplyRepository } from "../src/answer-replies/postgres-answer-reply-repository.js";
import { createAnswerReplyDeliveryService } from "../src/answer-replies/answer-reply-delivery-service.js";
import type { FeishuChatHistoryMessage, FeishuChatHistoryReader } from "../src/feishu/feishu-chat-history-reader.js";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
// Variable import keeps the standalone CLI outside Core's production rootDir.
const evalPath = "../../../scripts/pilot/proactive-discussion-eval.ts";
const evaluator = () => import(evalPath);

test("eval executes distinct rounds, never renders skip, and preserves each result", async () => {
  const { runProactiveDiscussionEval } = await evaluator();
  let calls = 0;
  const model: PdModel = { assess: async () => { calls++; return pdSkipAssessment(); },
    render: async () => { throw new Error("skip must not render"); } };
  const results = await runProactiveDiscussionEval({ model, cases: [{ id: "smalltalk", context: pdContext(),
    expectedDecision: "skip", reviewCriteria: ["不强行指出风险"] }], rounds: 2 });
  expect(calls).toBe(2);
  expect(results.map((r: { round: number }) => r.round)).toEqual([1, 2]);
  expect(results.every((r: { draft: unknown; error: unknown }) => r.draft === null && r.error === null)).toBe(true);
});

test("eval retains earlier output when later render fails, redacts errors and rejects zero-source contexts before model", async () => {
  const { runProactiveDiscussionEval } = await evaluator();
  let calls = 0;
  const model: PdModel = { assess: async () => { calls++; return pdAssessment(); },
    render: async ({ assessment }) => { if (calls === 2) throw new Error("API key secret-production-history");
      return { assessment, draft: { text: "两人共 16 万，建议核对预算。", evidenceRefs: assessment.evidenceRefs } }; } };
  const cases = [{ id: "arithmetic", context: pdContext(), expectedDecision: "intervene", reviewCriteria: ["16 万"] }];
  const results = await runProactiveDiscussionEval({ model, cases, rounds: 2 });
  expect(results[0].draft.text).toContain("16 万");
  expect(results[1]).toMatchObject({ round: 2, assessment: pdAssessment(), draft: null, error: "render_failed" });
  expect(JSON.stringify(results)).not.toContain("secret-production-history");
  await expect(runProactiveDiscussionEval({ model, cases: [{ ...cases[0], context: { ...pdContext(), sources: [], items: [] } }], rounds: 2 })).rejects.toThrow("context");
  expect(calls).toBe(2);
});

describe.skipIf(!process.env.IRIS_TEST_DATABASE_URL)("proactive discussion ingress to ordinary followup PostgreSQL", () => {
  let db: Awaited<ReturnType<typeof openPdDatabase>>;
  afterEach(async () => { await db?.close(); });

  async function setup() {
    db = await openPdDatabase();
    await db.repository.setPolicy({ policy: pdContext().policy, expectedVersion: 0, at });
    await db.pool.query(`UPDATE runtime_control_state SET desired_global_enabled=true,
      capabilities=jsonb_set(jsonb_set(jsonb_set(capabilities,'{readGroupContext}','true'),'{proactiveSpeech}','true'),'{replyWhenMentioned}','true')`);
    let clock = new Date(at);
    const remote = new Map<string, FeishuChatHistoryMessage>();
    const reader: FeishuChatHistoryReader = {
      async listRecentMessages() { return [...remote.values()].filter(m => m.role !== "assistant").map(m => ({ ...m })); },
      async readMessagesByIds({ messageIds, sender }) { return messageIds.flatMap(id => {
        const m = remote.get(id); return m && (sender === "assistant" ? m.role === "assistant" : m.role !== "assistant") ? [{ ...m }] : [];
      }); },
    };
    const documentVerifier = { async verify() { return []; } };
    const sourceVerifier = createPdSourceVerifier({ reader, documents: documentVerifier, canReadGroup: () => true, canProactivelySpeak: () => true });
    const documents = createDocumentRetrievalContextBuilder({ embeddingProfileId: "synthetic",
      embedder: { async embedTexts(texts) { return texts.map(() => [1]); } },
      fragments: { async searchSimilarFragments() { return []; } }, canReadDocument: async () => false });
    const contextBuilder = createPdContextBuilder({ repository: db.repository, reader, sourceVerifier,
      canReadGroup: () => true, documents: () => documents });
    const calls: string[] = [];
    const model: PdModel = {
      async assess(context) {
        calls.push(context.triggerMessageId);
        if (context.triggerMessageId === "m1") return pdSkipAssessment("insufficient_basis");
        const permission = context.triggerMessageId === "permission";
        const existing = context.issues.find(issue => issue.description === "招聘预算不足");
        const refs = context.items.filter(item => permission ? item.text.includes("权限") : item.text.includes("万")).map(item => item.ref);
        return { ...pdAssessment(), evidenceRefs: refs,
          issueRef: permission ? { kind: "new", description: "客户数据权限未确认" } : existing ? { kind: "existing", id: existing.id } : pdAssessment().issueRef,
          materialChange: { kind: permission || !existing ? "new_issue" : "new_evidence", explanation: "合成新依据", evidenceRefs: refs } };
      },
      async render({ assessment }) { return { assessment, draft: { text: assessment.issueRef?.kind === "new" && assessment.issueRef.description.includes("权限")
        ? "客户数据权限尚未确认，建议先核对授权范围。" : "两人共 16 万，比 10 万预算多 6 万，建议先核对预算。", evidenceRefs: assessment.evidenceRefs } }; },
    };
    const sent: { messageId: string; text: string }[] = [];
    const replier = { async replyText(input: { messageId: string; text: string }) {
      sent.push(input); const replyMessageId = `reply-${input.messageId}`;
      remote.set(replyMessageId, { messageId: replyMessageId, chatId: PILOT_CHAT, senderId: "iris", role: "assistant",
        text: input.text, sentAt: clock, parentMessageId: input.messageId });
      return { replyMessageId };
    } };
    const now = () => clock;
    const evaluation = createPdEvaluationWorker({ repository: db.repository, contextBuilder, model, reader,
      membership: { async isCurrentMember({ chatId, openId }) { return chatId === PILOT_CHAT && openId === "human"; } }, now, workerId: "e2e-eval" });
    const delivery = createPdDeliveryWorker({ repository: db.repository, reader, sourceVerifier, replier, now, workerId: "e2e-delivery" });
    const localMessageVerifier = createLocalMessageSourceVerifier({ reader, canReadGroup: () => true });
    const assistantReplies = createAssistantConversationContextProvider({ queryable: db.pool, reader, verifier: documentVerifier,
      localMessageVerifier, proactiveReceipts: createPdReceiptProvider({ queryable: db.pool }), requireChatProvenance: true });
    const ordinaryRepository = createPostgresAnswerReplyRepository({ dataSource: db.pool });
    const ordinaryInputs: string[] = [];
    const orchestrator = createAnswerDraftOrchestrator({
      liveChatContextProvider: createFeishuLiveChatContextProvider({ queryable: db.pool, reader, assistantReplies, now }), contextBuilder: documents,
      planner: { async plan() { return { taskMode: "direct_task", evidenceState: null, premises: [], proposedAnswer: null, missingInformation: [], confidence: null }; } },
      model: { async generateAnswerDraft(input) { ordinaryInputs.push(input.promptContext); return { answerText: "两人的成本加起来超出预算，最好先确认有没有追加预算。" }; } },
      renderer: { async render() { throw new Error("direct task does not use grounded renderer"); } },
    });
    const responder = createFeishuMentionAnswerResponder({ botOpenId: "iris", answerDraftOrchestrator: orchestrator,
      answerReplyDeliveryService: createAnswerReplyDeliveryService({ repository: ordinaryRepository, replier, verifier: documentVerifier, localMessageVerifier, now }), replier, now });
    const processor = createFeishuMessageEventProcessor({ messages: createPostgresConversationMessageRepository({ queryable: db.pool }),
      messageReplayGuard: createPostgresConversationMessageReplayGuard({ dataSource: db.pool }), mentionAnswerResponder: responder,
      proactiveDiscussionBotOpenId: "iris", proactiveDiscussionRegistrar: createPdRegistrar({ repository: db.repository, botOpenId: "iris", now }) });
    async function ingress(id: string, text: string, options: { parent?: string; mention?: boolean } = {}) {
      clock = new Date(clock.getTime() + 1000);
      remote.set(id, { messageId: id, chatId: PILOT_CHAT, senderId: "human", text, sentAt: clock,
        ...(options.parent ? { parentMessageId: options.parent } : {}) });
      await processor.process({ idempotencyKey: `raw-event:feishu:${id}`, provider: "feishu", eventType: "im.message.receive_v1", receivedAt: clock, attempts: 0,
        rawBody: { event: { sender: { sender_type: "user", sender_id: { open_id: "human" } }, message: {
          message_id: id, chat_id: PILOT_CHAT, message_type: "text", content: JSON.stringify({ text }), create_time: String(clock.getTime()),
          ...(options.parent ? { parent_id: options.parent } : {}),
          mentions: options.mention ? [{ key: "@iris", id: { open_id: "iris" } }] : [],
        } } } });
    }
    async function firstOpinion() {
      await ingress("m1", "预算只有 10 万"); expect(await evaluation.runOnce()).toBe("processed");
      await ingress("m2", "按每人 8 万招两人，预算够");
      expect((await db.pool.query("SELECT count(*)::integer AS n FROM proactive_discussion_jobs")).rows[0].n).toBe(2);
      expect(sent).toHaveLength(0);
      expect(await evaluation.runOnce()).toBe("processed"); expect(await delivery.runOnce()).toBe("processed");
      expect(await delivery.runOnce()).toBe("idle"); expect(sent).toHaveLength(1);
    }
    return { ingress, firstOpinion, evaluation, delivery, sent, calls, ordinaryInputs, ordinaryRepository, assistantReplies, remote, now };
  }

  test("ordinary non-mention persists and produces one policy receipt consumed by subsequent ordinary @ answer", async () => {
    const h = await setup(); await h.firstOpinion();
    expect((await db.pool.query("SELECT state,reply_message_id,authorization_kind FROM proactive_discussion_deliveries")).rows)
      .toEqual([expect.objectContaining({ state: "sent", reply_message_id: "reply-m2", authorization_kind: "policy" })]);
    await h.ingress("followup", "@iris 把刚才的建议说得口语一点", { mention: true, parent: "reply-m2" });
    expect(h.ordinaryInputs[0]).toContain(h.sent[0]!.text);
    const receipt = await h.ordinaryRepository.findByIncomingMessage({ provider: "feishu", incomingMessageId: "followup" });
    expect(receipt?.delivery.state).toBe("sent"); expect(receipt?.localMessageSources).toHaveLength(2);
    expect(h.calls).toEqual(["m1", "m2"]); expect(h.sent).toHaveLength(2);
    h.remote.set("m1", { ...h.remote.get("m1")!, text: "原数字已撤销" });
    expect(await h.assistantReplies.loadRecentReplies({ chatId: PILOT_CHAT, before: new Date(h.now().getTime() + 1000) })).toEqual([]);
  });

  test("member reply pauses the issue durably while an independent next issue still sends without cooldown", async () => {
    const h = await setup(); await h.firstOpinion();
    await h.ingress("stop", "不再跟进这件事", { parent: "reply-m2" });
    expect(await h.evaluation.runOnce()).toBe("processed");
    expect((await db.repository.readState(PILOT_CHAT)).issues[0]?.state).toBe("user_paused");
    await h.ingress("same", "报价改成每人 12 万，再看下预算");
    expect(await h.evaluation.runOnce()).toBe("processed"); expect(await h.delivery.runOnce()).toBe("idle"); expect(h.sent).toHaveLength(1);
    await h.ingress("permission", "客户数据权限还没确认，准备把完整客户名单对外开放");
    expect(await h.evaluation.runOnce()).toBe("processed"); expect(await h.delivery.runOnce()).toBe("processed");
    expect(h.sent).toHaveLength(2); expect(h.sent[1]?.messageId).toBe("permission");
    expect((await db.repository.readState(PILOT_CHAT)).issues.find(i => i.description === "招聘预算不足")?.state).toBe("user_paused");
  });
});
