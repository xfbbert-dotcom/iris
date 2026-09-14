import { afterEach, describe, expect, test, vi } from "vitest";
import { openPdDatabase, preparePdDelivery, pdTestAt as at, pdTestTime as time } from "./helpers/proactive-discussion-postgres.js";
import { PILOT_CHAT, pdContext, pdAssessment } from "./fixtures/proactive-discussion.js";
import { hashLocalMessageText } from "../src/memory/local-message-source.js";
import { createPdSourceRef } from "../src/proactive-discussion/contracts.js";
import { lockConversationMessageIngestScope } from "../src/conversation/conversation-message-replay-guard.js";
import { createPostgresProactiveDiscussionRepository } from "../src/proactive-discussion/postgres-repository.js";
import { createPostgresDocumentSourceGroupGrantRepository } from "../src/documents/postgres-document-source-group-grant-repository.js";
import type { TransactionClient } from "../src/conversation-state/postgres-conversation-state-repository.js";
import { createPostgresAnswerReplyRepository } from "../src/answer-replies/postgres-answer-reply-repository.js";
import { createAnswerReplyUuid, createAnswerReplySafeNoticeUuid } from "../src/answer-replies/answer-reply-repository.js";
import { createPassiveAssistantReceiptProvider } from "../src/memory/assistant-reply-receipt-provider.js";
import { createPdReceiptProvider } from "../src/proactive-discussion/receipt-provider.js";
import { deleteConversationMessageEvidence, ConversationEvidenceDeletionConflictError } from "../src/conversation-state/conversation-state-evidence-deletion.js";
import { createAssistantConversationContextProvider } from "../src/memory/assistant-conversation-context.js";
import { createFeishuLiveChatContextProvider } from "../src/memory/live-chat-context-provider.js";
import { createLocalMessageSourceVerifier } from "../src/memory/local-message-source.js";
import { createAnswerDraftOrchestrator } from "../src/agent/answer-draft-orchestrator.js";
import { createDocumentRetrievalContextBuilder } from "../src/memory/document-retrieval-context.js";
import { createAnswerReplyDeliveryService } from "../src/answer-replies/answer-reply-delivery-service.js";
import { createFeishuMentionAnswerResponder } from "../src/conversation/feishu-mention-answer-responder.js";
import { createProactiveDiscussionRuntime } from "../src/runtime/proactive-discussion-runtime.js";
import { RuntimeController } from "../src/admin/runtime-controller.js";
import { createDefaultRuntimeConfig } from "../src/config/runtime-config.js";
import { createDocumentFragmentRepository } from "../src/documents/document-fragment-repository.js";
import { createEmbeddingProfileRepository } from "../src/documents/embedding-profile-repository.js";
import type { FeishuChatHistoryMessage, FeishuChatHistoryReader } from "../src/feishu/feishu-chat-history-reader.js";

// Each case migrates an isolated schema; SQL lock waits remain capped at 3s.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

describe.skipIf(!process.env.IRIS_TEST_DATABASE_URL)("proactive discussion final send PostgreSQL", () => {
  let db: Awaited<ReturnType<typeof openPdDatabase>>;
  afterEach(async () => { await db?.close(); });
  async function setup(historyOnly = false) {
    db = await openPdDatabase(); await preparePdDelivery(db, historyOnly);
    return (await db.repository.claimDelivery({ workerId: "sender", at, leaseUntil: time(60) }))!;
  }
  async function preparePassive() {
    const delivery = await setup(true);
    await db.pool.query(`UPDATE runtime_control_state SET capabilities=jsonb_set(capabilities,'{replyWhenMentioned}','true')`);
    const repository = createPostgresAnswerReplyRepository({ dataSource: db.pool });
    const sources = delivery.sources.flatMap(source => source.kind === "message" ? [source.binding] : []);
    const { receipt } = await repository.prepare({ provider: "feishu", incomingMessageId: "followup", chatId: PILOT_CHAT,
      replyUuid: createAnswerReplyUuid("followup"), safeNoticeUuid: createAnswerReplySafeNoticeUuid("followup"), renderedText: "预算改写", sourceTraces: [],
      sharedChatSources: [], localMessageSources: sources, at });
    return { repository, receipt, sources };
  }
  test.each(["normal", "stop-before-review", "granted-document", "grant-revoked", "snapshot-replaced", "restored-wiki-disabled", "restored-source-disabled"])("actual PD factory runs registered work and honors transport lifecycle: %s", async mode => {
    db = await openPdDatabase();
    const context = pdContext();
    await db.repository.setPolicy({ policy: context.policy, expectedVersion: 0, at });
    await db.pool.query("UPDATE runtime_control_state SET desired_global_enabled=true, capabilities=jsonb_set(jsonb_set(capabilities,'{readGroupContext}','true'),'{proactiveSpeech}','true')");
    for (const [index, item] of context.items.entries()) {
      await db.pool.query(`INSERT INTO conversation_messages(id,provider,provider_message_id,chat_id,message_type,text,sender_open_id,sent_at,raw_event_idempotency_key)
        VALUES($1,'feishu',$2,$3,'text',$4,'human',$5,$2)`, [`feishu:m${index + 1}`, `m${index + 1}`, PILOT_CHAT, item.text, at]);
    }
    await db.repository.register({ chatId: PILOT_CHAT, messageId: "m2", contentHash: hashLocalMessageText(context.items[1]!.text), policyVersion: 1, purpose: "assessment", at });
    const sends: unknown[] = [];
    const modelInputs: string[] = [];
    const controller = new RuntimeController(createDefaultRuntimeConfig({}));
    const restoredPermissionChange = mode.startsWith("restored-");
    let revoke: (() => Promise<unknown>) | undefined;
    if (["granted-document", "grant-revoked", "snapshot-replaced"].includes(mode) || restoredPermissionChange) {
      await db.pool.query(`INSERT INTO document_sources(id,source_type,source_uri,origin_group_id,permission_state,sync_state,can_use_for_answering,can_use_for_knowledge_drafts,created_at,updated_at)
        VALUES('runtime-doc','group_visible_document','https://synthetic.feishu.cn/docx/runtimeDoc','owner','readable','synced',true,false,$1,$1)`, [at]);
      await db.pool.query(`INSERT INTO document_snapshots(id,document_source_id,source_uri,fetch_status,body_text,fetched_at,created_at)
        VALUES('runtime-snapshot','runtime-doc','https://synthetic.feishu.cn/docx/runtimeDoc','succeeded','grant-test-document-secret',$1,$1)`, [at]);
      const grants = createPostgresDocumentSourceGroupGrantRepository({ dataSource: db.pool });
      const grant = await grants.grant({ documentSourceId: "runtime-doc", grantorGroupId: "owner", granteeGroupId: PILOT_CHAT,
        expectedVersion: 0, operationKey: "runtime-grant", actorRef: "operator", at });
      await createDocumentFragmentRepository({ queryable: db.pool, embeddingProfiles: createEmbeddingProfileRepository({ queryable: db.pool }) })
        .replaceFragmentsForSnapshot({ documentSourceId: "runtime-doc", documentSnapshotId: "runtime-snapshot",
          sourceUri: "https://synthetic.feishu.cn/docx/runtimeDoc", embeddingProfileId: "static-dev-6d",
          chunks: [{ chunkIndex: 0, text: "grant-test-document-secret" }], embeddings: [[1,0,0,0,0,0]] });
      if (mode === "grant-revoked") revoke = () => grants.revoke({ grantId: grant.grant.id, expectedVersion: 1,
        operationKey: "runtime-revoke", actorRef: "operator", at });
      if (mode === "snapshot-replaced" || restoredPermissionChange) {
        const binding = { documentSourceId: "runtime-doc", documentSnapshotId: "runtime-snapshot",
          ...(mode === "restored-wiki-disabled" ? {} : { crossGroupGrantId: grant.grant.id,
            crossGroupGrantVersion: 1, crossGroupGrantorGroupId: "owner", crossGroupGranteeGroupId: PILOT_CHAT }) };
        await db.pool.query(`INSERT INTO proactive_discussion_issues(id,chat_id,description,state,version,basis_version,last_observation,last_reasoning,last_suggestion,basis_sources)
          VALUES('restored-issue',$1,'restored-issue-secret','surfaced',1,1,'restored-issue-secret','restored-issue-secret','restored-issue-secret',$2::jsonb)`,
          [PILOT_CHAT, JSON.stringify([{ kind: "document", binding, ref: createPdSourceRef({ kind: "document", binding }) }])]);
        if (mode === "snapshot-replaced") await db.pool.query(`INSERT INTO document_snapshots(id,document_source_id,source_uri,fetch_status,body_text,fetched_at,created_at)
          VALUES('new-runtime-snapshot','runtime-doc','https://synthetic.feishu.cn/docx/runtimeDoc','succeeded','new current source',$1,$1)`, [time(1)]);
        if (restoredPermissionChange) {
          // Only the restored premise is exposed, so mutate during its own final remote proof.
          await db.pool.query("DELETE FROM document_fragments WHERE document_source_id='runtime-doc'");
          if (mode === "restored-wiki-disabled") {
            await db.pool.query("UPDATE document_sources SET source_type='authorized_wiki_document',origin_group_id=$1 WHERE id='runtime-doc'", [PILOT_CHAT]);
            revoke = async () => controller.setCapability("retrieveKnowledgeBase", false);
          } else revoke = () => db.pool.query("UPDATE document_sources SET sync_state='failed' WHERE id='runtime-doc'");
        }
      }
    }
    let receiptSender = "app-id", receiptChat = PILOT_CHAT, receiptText = "两人需要 16 万，建议先核对预算。", receiptTarget = "m2";
    const modelOutputs = [pdAssessment(), { text: receiptText, evidenceRefs: pdAssessment().evidenceRefs }, { supported: true, reason: "supported" }];
    let runtime: ReturnType<typeof createProactiveDiscussionRuntime>;
    const messages = context.items.map((item, index) => ({ message_id: `m${index + 1}`, chat_id: PILOT_CHAT,
      deleted: false, sender: { sender_type: "user", id: "human" }, msg_type: "text",
      body: { content: JSON.stringify({ text: item.text }) }, create_time: String(at.getTime()) }));
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const path = String(url);
      if (path.endsWith("/chat/completions")) {
        modelInputs.push(String(init?.body));
        const output = modelOutputs.shift();
        if (mode === "stop-before-review" && modelOutputs.length === 1) void runtime.close();
        return Response.json({ choices: [{ message: { content: JSON.stringify(output) } }] });
      }
      if (path.includes("/docx/v1/documents/")) {
        const mutate = revoke; revoke = undefined; await mutate?.();
        return Response.json({ code: 0, data: {} });
      }
      if (path.includes("tenant_access_token")) return Response.json({ code: 0, tenant_access_token: "synthetic", expire: 7200 });
      if (path.endsWith("/reply")) { sends.push(JSON.parse(String(init?.body))); return Response.json({ code: 0, data: { message_id: "receipt" } }); }
      if (path.endsWith("/receipt")) return Response.json({ code: 0, data: { items: [{ ...messages[0], message_id: "receipt", chat_id: receiptChat,
        sender: { sender_type: "app", id: receiptSender }, body: { content: JSON.stringify({ text: receiptText }) }, parent_id: receiptTarget }] } });
      if (path.includes("/messages?")) return Response.json({ code: 0, data: { items: messages, has_more: false } });
      const message = messages.find(item => path.endsWith(`/${item.message_id}`));
      if (message) return Response.json({ code: 0, data: { items: [message] } });
      throw new Error(`unexpected synthetic endpoint: ${path}`);
    }) as unknown as typeof globalThis.fetch;
    runtime = createProactiveDiscussionRuntime({ env: {
      IRIS_PROACTIVE_DISCUSSION_ENABLED: "true", IRIS_PROACTIVE_DISCUSSION_GROUP_IDS: PILOT_CHAT,
      IRIS_PROACTIVE_DISCUSSION_POLL_INTERVAL_MS: "10", DATABASE_URL: process.env.IRIS_TEST_DATABASE_URL,
      FEISHU_APP_ID: "app-id", FEISHU_APP_SECRET: "synthetic", FEISHU_OPEN_BASE_URL: "http://127.0.0.1:1",
      IRIS_FEISHU_BOT_OPEN_ID: "ou_bot", IRIS_MODEL_PROVIDER: "openai-compatible", IRIS_MODEL_BASE_URL: "http://127.0.0.1:1/v1",
      IRIS_MODEL_API_KEY: "synthetic", IRIS_MODEL_NAME: "synthetic" },
      runtimeController: controller, now: () => at,
      dependencies: { createPostgresPool: () => Object.assign(Object.create(db.pool), { end: async () => undefined }), fetch },
    } as Parameters<typeof createProactiveDiscussionRuntime>[0]);
    try {
      await runtime.start();
      expect(await runtime.getStatus()).toMatchObject({ enabled: true, running: true, ok: true });
      if (mode === "stop-before-review") {
        await vi.waitFor(async () => expect((await db.pool.query("SELECT state FROM proactive_discussion_jobs")).rows[0].state).toBe("retry"), { timeout: 3000 });
        expect(modelOutputs).toHaveLength(1);
        expect(sends).toHaveLength(0);
        return;
      }
      if (mode === "grant-revoked") {
        await vi.waitFor(() => expect(modelInputs.length).toBeGreaterThan(0), { timeout: 3000 });
        expect(modelInputs.join(" ")).not.toContain("grant-test-document-secret");
      }
      if (mode === "snapshot-replaced" || restoredPermissionChange) {
        await vi.waitFor(() => expect(modelInputs.length).toBeGreaterThan(0), { timeout: 3000 });
        if (restoredPermissionChange) expect(revoke).toBeUndefined();
        expect(modelInputs.join(" ")).not.toContain("restored-issue-secret");
        await vi.waitFor(async () => expect((await db.pool.query("SELECT last_error FROM proactive_discussion_jobs")).rows[0].last_error).toBe("incomplete_catalog"));
        expect(sends).toHaveLength(0);
        return;
      }
      await vi.waitFor(async () => expect((await db.pool.query("SELECT state FROM proactive_discussion_deliveries")).rows[0].state).toBe("sent"), { timeout: 3000 });
      expect(sends).toHaveLength(1);
      expect(modelOutputs).toHaveLength(0);
      if (mode === "granted-document") expect(modelInputs.join(" ")).toContain("grant-test-document-secret");
      if (mode === "grant-revoked") expect(modelInputs.join(" ")).not.toContain("grant-test-document-secret");
      const delivery = (await db.pool.query("SELECT id FROM proactive_discussion_deliveries")).rows[0];
      const saved = (await runtime.control!.repository.readDelivery(delivery.id))!;
      expect(await runtime.control!.verifySentReceipt(saved, "receipt")).toBe(true);
      for (const mutate of [() => { receiptSender = "foreign-app"; }, () => { receiptChat = "foreign-chat"; },
        () => { receiptText = "edited"; }, () => { receiptTarget = "other-parent"; }]) {
        mutate(); expect(await runtime.control!.verifySentReceipt(saved, "receipt")).toBe(false);
        receiptSender = "app-id"; receiptChat = PILOT_CHAT; receiptText = saved.text; receiptTarget = "m2";
      }
    } finally { await runtime.close(); }
  });
  test("operator resume uses issue CAS, records truthful origin, cancels old draft and never creates a job", async () => {
    const delivery = await setup();
    await db.pool.query("UPDATE proactive_discussion_issues SET state='user_paused',version=version+1 WHERE id=$1", [delivery.issueId]);
    const issue = (await db.repository.readState(PILOT_CHAT)).issues[0]!;
    const input = { chatId: PILOT_CHAT, issueId: issue.id, expectedVersion: issue.version, operatorId: "internal-api:operations", at };
    expect(typeof db.repository.resumeByOperator).toBe("function");
    expect(await Promise.all([db.repository.resumeByOperator(input), db.repository.resumeByOperator(input)]))
      .toEqual(expect.arrayContaining(["applied", "conflict"]));
    expect((await db.repository.readState(PILOT_CHAT)).issues[0]).toMatchObject({ state: "observing", version: issue.version + 1 });
    expect(await db.repository.readDelivery(delivery.id)).toMatchObject({ state: "cancelled", replyMessageId: null, version: expect.any(Number) });
    expect(await db.repository.readDelivery(delivery.id)).not.toHaveProperty("checkedRuntimeRevision");
    expect((await db.pool.query("SELECT count(*)::integer AS n FROM proactive_discussion_jobs")).rows[0].n).toBe(1);
    const audit = await db.pool.query("SELECT payload FROM proactive_discussion_events WHERE entity_type='issue' AND payload->>'origin'='operator'");
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].payload).toMatchObject({ operatorId: "internal-api:operations", action: "resume" });
    expect(await db.repository.resumeByOperator({ ...input, chatId: "other" })).toBe("blocked");
  });
  test("passive local trace roundtrip is immutable and rereads complete sent provenance", async () => {
    const { repository, receipt, sources } = await preparePassive();
    expect(receipt.localMessageSources).toEqual(sources);
    expect((await repository.findByIncomingMessage({ provider: "feishu", incomingMessageId: "followup" }))?.localMessageSources).toEqual(sources);
    await expect(db.pool.query("UPDATE answer_reply_local_source_traces SET content_hash=repeat('b',64)")).rejects.toThrow();
    await expect(db.pool.query("DELETE FROM answer_reply_local_source_traces")).rejects.toThrow();
    const sending = await repository.beginAnswerSend({ deliveryId: receipt.delivery.id, expectedVersion: receipt.delivery.version, at });
    await repository.completeAnswerSend({ deliveryId: sending.delivery.id, expectedVersion: sending.delivery.version, replyMessageId: "rewritten", at: time(1) });
    const candidates = await createPassiveAssistantReceiptProvider({ queryable: db.pool }).listRecentSent({ chatId: PILOT_CHAT, after: at, before: time(10), limit: 2 });
    expect(candidates[0]?.localMessageSources).toEqual(sources);
    expect(candidates[0]?.provenanceVersion).toBe(1);
    expect((await db.pool.query("SELECT id FROM conversation_messages WHERE id='feishu:m1'")).rows).toEqual([]);
  });
  test("local-only source permission disabled after preparation blocks passive beginSend", async () => {
    const { repository, receipt } = await preparePassive();
    await db.pool.query("UPDATE runtime_control_state SET desired_global_enabled=false,revision=revision+1");
    await expect(repository.beginAnswerSend({ deliveryId: receipt.delivery.id, expectedVersion: receipt.delivery.version, at })).rejects.toThrow();
    expect((await repository.findByIncomingMessage({ provider: "feishu", incomingMessageId: "followup" }))?.delivery.state).toBe("prepared");
  });
  test("a local source deleted after preparation blocks passive beginSend", async () => {
    const { repository, receipt } = await preparePassive();
    await deleteConversationMessageEvidence({ dataSource: db.pool, groupId: PILOT_CHAT, messageId: "feishu:m2", operatorHint: "test" });
    await expect(repository.beginAnswerSend({ deliveryId: receipt.delivery.id, expectedVersion: receipt.delivery.version, at })).rejects.toThrow();
  });
  test("a declared passive local-source send protects its source until delivery settlement", async () => {
    const { repository, receipt } = await preparePassive();
    const sending = await repository.beginAnswerSend({ deliveryId: receipt.delivery.id, expectedVersion: receipt.delivery.version, at });
    await expect(deleteConversationMessageEvidence({ dataSource: db.pool, groupId: PILOT_CHAT, messageId: "feishu:m2", operatorHint: "test" })).rejects.toBeInstanceOf(ConversationEvidenceDeletionConflictError);
    expect((await db.pool.query("SELECT provider_message_id FROM conversation_message_deletion_tombstones")).rows).toEqual([]);
    await repository.completeAnswerSend({ deliveryId: sending.delivery.id, expectedVersion: sending.delivery.version, replyMessageId: "sent", at: time(1) });
    expect(await deleteConversationMessageEvidence({ dataSource: db.pool, groupId: PILOT_CHAT, messageId: "feishu:m2", operatorHint: "test" })).toMatchObject({ status: "deleted" });
  });
  test("proactive provider admits actual sent sources and excludes an uncertain delivery", async () => {
    const delivery = await setup(true);
    const provider = createPdReceiptProvider({ queryable: db.pool });
    const window = { chatId: PILOT_CHAT, after: at, before: time(10), limit: 2 };
    await db.repository.beginSend({ delivery, checkedContextVersion: delivery.contextVersion, at });
    await db.repository.finishSend({ delivery, outcome: "outcome_unknown", at: time(1) });
    expect(await provider.listRecentSent(window)).toEqual([]);
    const version = Number((await db.pool.query("SELECT version FROM proactive_discussion_deliveries WHERE id=$1", [delivery.id])).rows[0].version);
    await db.repository.reconcile({ deliveryId: delivery.id, expectedVersion: version, operatorId: "test-operator", outcome: "sent", replyMessageId: "opinion", evidence: "synthetic verified receipt", at: time(2) });
    const [receipt] = await provider.listRecentSent(window);
    expect(receipt.localMessageSources).toEqual(delivery.sources.flatMap(source => source.kind === "message" ? [source.binding] : []));
    expect(receipt.provenanceVersion).toBe(1);
  });
  test("actual proactive sent receipt survives two ordinary responder rewrites with immutable local traces", async () => {
    const delivery = await setup(true);
    await db.pool.query(`UPDATE runtime_control_state SET capabilities=jsonb_set(capabilities,'{replyWhenMentioned}','true')`);
    await db.repository.beginSend({ delivery, checkedContextVersion: delivery.contextVersion, at });
    await db.repository.finishSend({ delivery, outcome: "sent", replyMessageId: "opinion", at: time(1) });
    let clock = time(2);
    let latestId = "opinion";
    let latestBody = delivery.text;
    const remote = new Map<string, FeishuChatHistoryMessage>();
    pdContext().items.forEach((item, index) => remote.set(`m${index + 1}`, { messageId: `m${index + 1}`, chatId: PILOT_CHAT, senderId: "human", text: item.text, sentAt: at }));
    remote.set("opinion", { messageId: "opinion", chatId: PILOT_CHAT, senderId: "iris", role: "assistant", text: latestBody, sentAt: time(1) });
    const reader: FeishuChatHistoryReader = { async listRecentMessages() { return []; }, async readMessagesByIds({ messageIds, sender }) {
      return messageIds.flatMap(id => { const message = remote.get(id); return message && (sender === "assistant" ? id === latestId : message.role !== "assistant") ? [{ ...message }] : []; });
    } };
    const localMessageVerifier = createLocalMessageSourceVerifier({ reader, canReadGroup: () => true });
    const documentVerifier = { async verify() { return []; } };
    const assistantReplies = createAssistantConversationContextProvider({ queryable: db.pool, reader, verifier: documentVerifier,
      localMessageVerifier, proactiveReceipts: createPdReceiptProvider({ queryable: db.pool }), requireChatProvenance: true });
    const liveChatContextProvider = createFeishuLiveChatContextProvider({ queryable: db.pool, reader, assistantReplies, now: () => clock });
    const repository = createPostgresAnswerReplyRepository({ dataSource: db.pool });
    const replier = { async replyText({ messageId, text }: { messageId: string; text: string }) {
      latestId = `reply-${messageId}`; latestBody = text;
      remote.set(latestId, { messageId: latestId, chatId: PILOT_CHAT, senderId: "iris", role: "assistant", text, sentAt: clock });
      return { replyMessageId: latestId };
    } };
    const service = createAnswerReplyDeliveryService({ repository, replier, verifier: documentVerifier, localMessageVerifier, now: () => clock });
    for (let round = 1; round <= 2; round++) {
      const expectedBody = latestBody;
      const orchestrator = createAnswerDraftOrchestrator({ liveChatContextProvider,
        contextBuilder: createDocumentRetrievalContextBuilder({ embeddingProfileId: "test", embedder: { async embedTexts(texts) { return texts.map(() => [1]); } }, fragments: { async searchSimilarFragments() { return []; } }, canReadDocument: async () => false }),
        planner: { async plan() { return { taskMode: "direct_task", evidenceState: null, premises: [], proposedAnswer: null, missingInformation: [], confidence: null }; } },
        model: { async generateAnswerDraft(input) { expect(input.promptContext).toContain(expectedBody); return { answerText: `预算意见第${round}次改写` }; } },
        renderer: { async render() { throw new Error("direct rewrite uses ordinary model"); } },
      });
      const responder = createFeishuMentionAnswerResponder({ botOpenId: "iris", answerDraftOrchestrator: orchestrator, answerReplyDeliveryService: service, replier, now: () => clock });
      expect(await responder.maybeRespond({ messageId: `rewrite-${round}`, chatId: PILOT_CHAT, senderId: "human", text: "@iris 把上条意见改短一点", mentions: [{ key: "@iris", openId: "iris" }] })).toMatchObject({ status: "replied", replyMessageId: `reply-rewrite-${round}` });
      const receipt = await repository.findByIncomingMessage({ provider: "feishu", incomingMessageId: `rewrite-${round}` });
      expect(receipt?.localMessageSources).toEqual(delivery.sources.flatMap(source => source.kind === "message" ? [source.binding] : []));
      expect(receipt?.chatSources).toEqual([]);
      expect(receipt?.delivery.state).toBe("sent");
      clock = new Date(clock.getTime() + 1000);
    }
    expect((await assistantReplies.loadRecentReplies({ chatId: PILOT_CHAT, before: clock }))[0]?.messageId).toBe("reply-rewrite-2");
    remote.set("m1", { ...remote.get("m1")!, text: "预算已经改为 20 万" });
    expect(await assistantReplies.loadRecentReplies({ chatId: PILOT_CHAT, before: clock })).toEqual([]);
    expect((await db.pool.query("SELECT id FROM conversation_messages WHERE id='feishu:m1'")).rows).toEqual([]);
  });
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
