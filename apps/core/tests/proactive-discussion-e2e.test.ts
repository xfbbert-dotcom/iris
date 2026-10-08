import { readFileSync } from "node:fs";
import { afterEach, describe, expect, test, vi } from "vitest";
import { openPdDatabase, pdTestAt as at } from "./helpers/proactive-discussion-postgres.js";
import { pdContext, pdAssessment, pdSkipAssessment, PILOT_CHAT } from "./fixtures/proactive-discussion.js";
import { createPdModel, type PdModel } from "../src/proactive-discussion/model.js";
import { pdOpinionModeOptions } from "../src/proactive-discussion/opinion-mode.js";
import { pdCanonicalOpinionPlanFormat, pdOpinionPlanSystem } from "../src/proactive-discussion/opinion-plan.js";
import { pdOpinionSelectionFormat } from "../src/proactive-discussion/source-selection.js";
import type { PdAssessment, PdContext, PdDraft } from "../src/proactive-discussion/contracts.js";
import type { OpenAICompatibleChatMessage } from "../src/model/openai-compatible-chat-completions-client.js";
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

describe.skipIf(!process.env.IRIS_TEST_DATABASE_URL)("source-plan archived response PostgreSQL delivery", () => {
  let db: Awaited<ReturnType<typeof openPdDatabase>> | undefined;
  afterEach(async () => { try { await db?.close(); } finally { db = undefined; vi.unstubAllGlobals(); } });

  async function setup(caseId: "arithmetic" | "hypothesis") {
    // Offline transport fixtures, not a new model run or real Feishu delivery.
    const archive = JSON.parse(readFileSync(new URL(
      "../../../docs/development/evidence/iris-opinion-decision-resumed-20261004.json", import.meta.url), "utf8")) as {
      completions: { caseId: string; stage: string; messages: OpenAICompatibleChatMessage[]; responseFormat: unknown; content: string }[];
      results: { caseId: string; kind: string; initialAssessment: PdAssessment; assessment: PdAssessment; draft: PdDraft | null }[];
    };
    const expected = archive.results.find(result => result.caseId === caseId && result.kind === "fresh")!;
    const responses = archive.completions.filter(response => response.caseId === caseId);
    const stages = caseId === "arithmetic" ? ["iris_proactive_discussion_assessment",
      "iris_proactive_discussion_opinion_plan", "iris_proactive_discussion_scope_review"] : ["iris_proactive_discussion_assessment"];
    expect(responses.map(response => response.stage)).toEqual(stages);
    expect(expected).toBeDefined();
    const { createProactiveDiscussionEvalCases } = await evaluator();
    const cases: { id: string; context: PdContext }[] = createProactiveDiscussionEvalCases();
    const { context } = cases.find(entry => entry.id === caseId)!;
    const network = vi.fn(async () => { throw new Error("network forbidden in archived PostgreSQL replay"); });
    vi.stubGlobal("fetch", network);
    db = await openPdDatabase();
    await db.repository.setPolicy({ policy: context.policy, expectedVersion: 0, at });
    await db.pool.query(`UPDATE runtime_control_state SET desired_global_enabled=true,
      capabilities=jsonb_set(jsonb_set(capabilities,'{readGroupContext}','true'),'{proactiveSpeech}','true')`);
    const now = () => new Date(at.getTime() + 3000);
    const remote = new Map<string, FeishuChatHistoryMessage>();
    const messages = createPostgresConversationMessageRepository({ queryable: db.pool });
    const registrar = createPdRegistrar({ repository: db.repository, botOpenId: "iris", now });
    for (const [index, source] of context.sources.entries()) {
      if (source.kind !== "message") throw new Error("replay only contains synthetic message sources");
      const messageId = source.binding.messageId, text = context.items[index]!.text;
      const sentAt = new Date(at.getTime() + index * 1000);
      remote.set(messageId, { messageId, chatId: PILOT_CHAT, senderId: "human", text, sentAt });
      const conversationMessage = await messages.upsertMessage({ provider: "feishu", providerMessageId: messageId,
        chatId: PILOT_CHAT, senderOpenId: "human", messageType: "text", text, sentAt,
        rawEventIdempotencyKey: `source-plan-replay:${messageId}` });
      if (messageId === context.triggerMessageId) await registrar.registerMessage({ conversationMessage, senderType: "user", mentionedIris: false });
    }
    expect((await db.pool.query("SELECT message_id,state FROM proactive_discussion_jobs")).rows)
      .toEqual([{ message_id: context.triggerMessageId, state: "pending" }]);
    const before = await db.repository.readState(PILOT_CHAT);
    const reader: FeishuChatHistoryReader = {
      async listRecentMessages() { return [...remote.values()].filter(message => message.role !== "assistant"); },
      async readMessagesByIds({ messageIds, sender }) { return messageIds.flatMap(id => {
        const message = remote.get(id);
        return message && (sender === "assistant" ? message.role === "assistant" : message.role !== "assistant") ? [message] : [];
      }); },
    };
    const sourceVerifier = createPdSourceVerifier({ reader, documents: { async verify() { return []; } },
      canReadGroup: chatId => chatId === PILOT_CHAT, canProactivelySpeak: chatId => chatId === PILOT_CHAT });
    const documents = createDocumentRetrievalContextBuilder({ embeddingProfileId: "synthetic",
      embedder: { async embedTexts(texts) { return texts.map(() => [1]); } },
      fragments: { async searchSimilarFragments() { return []; } }, canReadDocument: async () => false });
    const contextBuilder = createPdContextBuilder({ repository: db.repository, reader, sourceVerifier,
      canReadGroup: chatId => chatId === PILOT_CHAT, documents: () => documents });
    const calls: string[] = [], requestFailures: unknown[] = [];
    const model = createPdModel({ ...pdOpinionModeOptions("source-plan"), client: { async complete(request, options) {
      try {
        const response = responses.shift();
        if (!response) throw new Error("unexpected model call after archived responses were exhausted");
        const stage = options?.responseFormat?.json_schema.name;
        calls.push(stage!);
        expect(stage).toBe(response.stage);
        if (stage === "iris_proactive_discussion_opinion_plan") {
          // Explicit wire adaptation: current dependency/inference use ranges;
          // this archive only returns calculation, whose response stays unchanged.
          // Compare the old canonical contract separately; never rewrite the archive.
          expect(options!.responseFormat).toEqual(pdOpinionSelectionFormat());
          const currentFormat = pdCanonicalOpinionPlanFormat() as any;
          const branches = currentFormat.json_schema.schema.anyOf;
          const withdrawal = branches.find((branch: any) => branch.properties.kind.enum[0] === "no_intervention");
          expect(withdrawal).toEqual({ type: "object", additionalProperties: false, required: ["kind", "reason"],
            properties: { kind: { type: "string", enum: ["no_intervention"] },
              reason: { type: "string", enum: ["no_material_issue", "insufficient_basis", "already_handled"] } } });
          currentFormat.json_schema.schema.anyOf = branches.filter((branch: any) => branch !== withdrawal);
          expect(currentFormat).toEqual(response.responseFormat);
          const actualBranches = (options!.responseFormat!.json_schema.schema as any).anyOf;
          expect(actualBranches.find((branch: any) => branch.properties.kind.enum[0] === "calculation"))
            .toEqual(branches.find((branch: any) => branch.properties.kind.enum[0] === "calculation"));
          expect(request[0]).toEqual({ role: "system", content: pdOpinionPlanSystem });
        } else {
          expect(options?.responseFormat).toEqual(response.responseFormat);
          // Scope now explains locator IDs and the separately resolved plan.
          const expectedSystem = stage === "iris_proactive_discussion_scope_review"
            ? response.messages[0]!.content.replace("程序只保证引文字面绑定", "sourceCatalog的编号及startUnit/endUnit只定位原文，不是业务数值或事实。resolvedSourcePlan由程序按目录连续范围还原原句；程序只保证引文字面绑定")
            : response.messages[0]!.content;
          expect(request[0]).toEqual({ ...response.messages[0], content: expectedSystem });
        }
        expect(request).toHaveLength(2);
        expect(request[1]!.role).toBe(response.messages[1]!.role);
        const archivedInput = JSON.parse(response.messages[1]!.content);
        // Persisted versions come from this real database, never from the archived eval.
        // All other business materials, source refs, identity and compiled prose must match.
        const expectedInput = stage === "iris_proactive_discussion_assessment"
          ? { ...archivedInput, contextVersion: before.contextVersion, catalogVersion: before.catalogVersion } : archivedInput;
        const actualInput = JSON.parse(request[1]!.content);
        if (stage !== "iris_proactive_discussion_assessment") {
          // Added locator metadata exhaustively represents the identical evidence.
          expect(actualInput.sourceCatalog.map((source: any) => ({ ref: source.sourceRef,
            text: source.units.map((unit: any) => unit.text).join("") })))
            .toEqual(actualInput.evidence.map(({ ref, text }: any) => ({ ref, text })));
          delete actualInput.sourceCatalog;
          if (stage === "iris_proactive_discussion_scope_review") {
            expect(actualInput.resolvedSourcePlan).toEqual(actualInput.sourcePlan);
            delete actualInput.resolvedSourcePlan;
          }
        }
        expect(actualInput).toEqual(expectedInput);
        return response.content;
      } catch (error) { requestFailures.push(error); throw error; }
    } } });
    const sent: { messageId: string; text: string }[] = [];
    const replier = { async replyText(input: { messageId: string; text: string }) {
      sent.push({ messageId: input.messageId, text: input.text });
      return { replyMessageId: `offline-reply-${input.messageId}` };
    } };
    const evaluation = createPdEvaluationWorker({ repository: db.repository, contextBuilder, model, reader,
      membership: { async isCurrentMember() { return false; } }, now, workerId: "source-plan-replay-eval" });
    const delivery = createPdDeliveryWorker({ repository: db.repository, sourceVerifier, reader, replier,
      now, workerId: "source-plan-replay-delivery" });
    const outcome = await evaluation.runOnce();
    expect(requestFailures).toEqual([]);
    expect(outcome).toBe("processed");
    expect(calls).toEqual(stages);
    expect(responses).toHaveLength(0);
    expect(sent).toHaveLength(0);
    expect((await db.pool.query("SELECT assessment,draft,outcome FROM proactive_discussion_evaluations")).rows)
      .toEqual([{ assessment: expected.assessment, draft: expected.draft,
        outcome: caseId === "arithmetic" ? "prepared" : "skipped" }]);
    expect(await evaluation.runOnce()).toBe("idle");
    return { database: db, context, expected, delivery, sent, network, calls, stages };
  }

  test("accepted source-plan pair is persisted and sent exactly once instead of the initial assessment", async () => {
    const h = await setup("arithmetic");
    expect(h.expected.assessment).not.toEqual(h.expected.initialAssessment);
    const issueRef = h.expected.assessment.issueRef;
    if (issueRef?.kind !== "new") throw new Error("arithmetic archive must introduce its first issue");
    expect((await h.database.repository.readState(PILOT_CHAT)).issues).toEqual([expect.objectContaining({
      description: issueRef.description,
      lastObservation: h.expected.assessment.observation, lastReasoning: h.expected.assessment.reasoning,
      lastSuggestion: h.expected.assessment.suggestion, basisSources: h.context.sources, proseSources: h.context.sources,
    })]);
    expect((await h.database.pool.query("SELECT trigger_message_id,text,state,authorization_kind FROM proactive_discussion_deliveries")).rows)
      .toEqual([{ trigger_message_id: h.context.triggerMessageId, text: h.expected.draft!.text, state: "prepared", authorization_kind: "policy" }]);
    expect(await h.delivery.runOnce()).toBe("processed");
    expect(h.sent).toEqual([{ messageId: h.context.triggerMessageId, text: h.expected.draft!.text }]);
    expect((await h.database.pool.query("SELECT state,reply_message_id FROM proactive_discussion_deliveries")).rows)
      .toEqual([{ state: "sent", reply_message_id: `offline-reply-${h.context.triggerMessageId}` }]);
    expect(await h.delivery.runOnce()).toBe("idle");
    expect(h.sent).toHaveLength(1);
    expect(h.calls).toEqual(h.stages);
    expect(h.network).not.toHaveBeenCalled();
  });

  test("source-plan structured silence persists without any plan, issue or delivery", async () => {
    const h = await setup("hypothesis");
    expect(h.expected.assessment).toMatchObject({ decision: "skip", reason: "no_work_value",
      observation: "", reasoning: "", suggestion: "" });
    expect(h.expected.draft).toBeNull();
    expect((await h.database.repository.readState(PILOT_CHAT)).issues).toEqual([]);
    expect((await h.database.pool.query("SELECT id FROM proactive_discussion_deliveries")).rows).toEqual([]);
    expect(await h.delivery.runOnce()).toBe("idle");
    expect(h.sent).toEqual([]);
    expect(h.calls).toEqual(["iris_proactive_discussion_assessment"]);
    expect(h.network).not.toHaveBeenCalled();
  });
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
