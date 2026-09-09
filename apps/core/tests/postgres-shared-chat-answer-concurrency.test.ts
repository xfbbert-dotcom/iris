import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { defaultMigrationsDir, runMigrations } from "../src/database/migrate.js";
import { createFeishuMessageEventProcessor } from "../src/conversation/feishu-message-event-processor.js";
import { createFeishuMentionAnswerResponder } from "../src/conversation/feishu-mention-answer-responder.js";
import { createPostgresConversationMessageReplayGuard } from "../src/conversation/conversation-message-replay-guard.js";
import { createPostgresConversationMessageRepository } from "../src/conversation/postgres-conversation-message-repository.js";
import { createAnswerReplyDeliveryService } from "../src/answer-replies/answer-reply-delivery-service.js";
import { createPostgresAnswerReplyRepository, type PostgresAnswerReplyDataSource } from "../src/answer-replies/postgres-answer-reply-repository.js";
import { createAnswerReplySafeNoticeUuid, createAnswerReplyUuid } from "../src/answer-replies/answer-reply-repository.js";
import { ConversationEvidenceDeletionConflictError, deleteConversationMessageEvidence } from "../src/conversation-state/conversation-state-evidence-deletion.js";
import { createPostgresWorkingChatScopeRepository } from "../src/shared-chat/postgres-working-chat-scope-repository.js";
import { WorkingChatScopeConflictError, WorkingChatScopeStaleError, hashSharedChatText } from "../src/shared-chat/working-chat-scope.js";
import type { RawEvent } from "../src/events/raw-event-queue.js";
import type { FeishuChatHistoryMessage, FeishuChatHistoryReader } from "../src/feishu/feishu-chat-history-reader.js";
import { createAnswerDraftOrchestrator } from "../src/agent/answer-draft-orchestrator.js";
import { createDocumentRetrievalContextBuilder } from "../src/memory/document-retrieval-context.js";
import { createFeishuLiveChatContextProvider } from "../src/memory/live-chat-context-provider.js";
import { createAssistantConversationContextProvider } from "../src/memory/assistant-conversation-context.js";
import { createSharedChatSourceVerifier } from "../src/shared-chat/shared-chat-source-verifier.js";

const databaseUrl = process.env.IRIS_TEST_DATABASE_URL?.trim();
const runIfDatabase = databaseUrl ? describe : describe.skip;
const groups = [{ chatId: "group-a", name: "A" }, { chatId: "group-b", name: "B" }];

runIfDatabase("shared-chat answer transaction boundaries with disposable PostgreSQL", () => {
  let admin: pg.Pool;
  let pool: pg.Pool;
  let casePool: pg.Pool | undefined;
  let caseSchema: string | undefined;
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: databaseUrl });
  });
  afterAll(async () => { await admin?.end(); });
  beforeEach(async () => {
    // Delivery FKs reach immutable document/event tables whose statement triggers reject
    // TRUNCATE even when empty. Isolate each case instead of weakening append-only guards.
    const schema = `shared_answer_${randomUUID().replaceAll("-", "")}`;
    const client = await admin.connect();
    try {
      await client.query(`CREATE SCHEMA ${schema}`);
      caseSchema = schema;
      await client.query(`SET search_path TO ${schema}, public`);
      await runMigrations({ client, migrationsDir: defaultMigrationsDir() });
    } finally { client.release(); }
    // Statement timeout also bounds the pre-fix application-level lock cycle.
    pool = new pg.Pool({ connectionString: databaseUrl,
      options: `-c search_path=${schema},public -c statement_timeout=3000`, max: 12 });
    casePool = pool;
    await pool.query(`UPDATE runtime_control_state SET desired_global_enabled = true, disabled_group_ids = '{}',
      capabilities = capabilities || '{"readGroupContext":true,"replyWhenMentioned":true}'::jsonb`);
    await createPostgresWorkingChatScopeRepository({ dataSource: pool }).replace({ expectedVersion: 0,
      state: "active", groups, updatedBy: "test", at: new Date() });
  }, 60_000);
  afterEach(async () => {
    const finishedPool = casePool;
    const finishedSchema = caseSchema;
    casePool = undefined;
    caseSchema = undefined;
    try { await finishedPool?.end(); }
    finally {
      if (finishedSchema !== undefined) {
        if (!/^shared_answer_[a-f0-9]{32}$/u.test(finishedSchema)) throw new Error("invalid disposable schema name");
        await admin.query(`DROP SCHEMA IF EXISTS ${finishedSchema} CASCADE`);
      }
    }
  }, 60_000);

  it("completes reciprocal ordinary A/B requests whose incoming messages are each other's source", async () => {
    const bothModelsEntered = deferred();
    let entered = 0;
    const sent: string[] = [];
    const repository = createPostgresAnswerReplyRepository({ dataSource: pool });
    const replier = { async replyText({ messageId }: { messageId: string }) {
      sent.push(messageId); return { replyMessageId: `reply-${messageId}` };
    } };
    const responder = createFeishuMentionAnswerResponder({
      botOpenId: "iris", replier,
      answerReplyDeliveryService: createAnswerReplyDeliveryService({ repository, replier,
        verifier: { verify: async () => [] }, sharedChatVerifier: { verify: async () => true } }),
      answerDraftOrchestrator: {
        inspectPromptPermissions: async () => ({ blockedDocumentSourceIds: [] }),
        async generateDraft(input) {
          if (++entered === 2) bothModelsEntered.resolve();
          await bothModelsEntered.promise;
          return { answerText: "Shared answer", promptContext: "", allowedFragments: [], deniedDocumentIds: [],
            retrievedFragmentCount: 0, usedGroupMemories: [],
            sharedChatSources: [sourceFor(input.chatId!)] };
        },
      },
    });
    const processor = createFeishuMessageEventProcessor({
      messages: createPostgresConversationMessageRepository({ queryable: pool }),
      messageReplayGuard: createPostgresConversationMessageReplayGuard({ dataSource: pool }),
      mentionAnswerResponder: responder,
    });
    await Promise.all([processor.process(eventFor("group-a")), processor.process(eventFor("group-b"))]);
    expect(sent.sort()).toEqual(["incoming-a", "incoming-b"]);
    for (const suffix of ["a", "b"]) {
      const receipt = await repository.findByIncomingMessage({ provider: "feishu", incomingMessageId: `incoming-${suffix}` });
      expect(receipt?.delivery.state).toBe("sent");
      expect(receipt?.chatSources).toEqual([sourceFor(`group-${suffix}`)]);
    }
  }, 12_000);

  it.each(["source", "incoming"])("deletion of %s wins before prepare and before send", async kind => {
    await seedMessages();
    const repository = createPostgresAnswerReplyRepository({ dataSource: pool });
    const prepared = await repository.prepare(preparation());
    const groupId = kind === "source" ? "group-a" : "group-b";
    await expect(deleteConversationMessageEvidence({ dataSource: pool, groupId,
      messageId: `feishu:incoming-${kind === "source" ? "a" : "b"}`, operatorHint: "test" })).resolves.toMatchObject({ status: "deleted" });
    await expect(repository.beginAnswerSend({ deliveryId: prepared.receipt.delivery.id, expectedVersion: 1, at: new Date() }))
      .rejects.toBeInstanceOf(WorkingChatScopeStaleError);
    await expect(repository.prepare(preparation())).rejects.toBeInstanceOf(WorkingChatScopeStaleError);
    expect((await repository.findByIncomingMessage(preparation()))?.delivery.attemptCount).toBe(0);
  });

  it.each(["scope", "source", "incoming"])("a committed send start rejects concurrent %s removal", async kind => {
    await seedMessages();
    const boundary = pauseAfterQuery(sql => /SET state = 'sending'/u.test(sql));
    const repository = createPostgresAnswerReplyRepository({ dataSource: boundary.dataSource });
    const prepared = await repository.prepare(preparation());
    const sending = repository.beginAnswerSend({ deliveryId: prepared.receipt.delivery.id, expectedVersion: 1, at: new Date() });
    await boundary.entered.promise;
    const mutation = kind === "scope"
      ? createPostgresWorkingChatScopeRepository({ dataSource: pool }).replace({ expectedVersion: 1, state: "revoked", groups, updatedBy: "test", at: new Date() })
      : deleteConversationMessageEvidence({ dataSource: pool, groupId: kind === "source" ? "group-a" : "group-b",
          messageId: `feishu:incoming-${kind === "source" ? "a" : "b"}`, operatorHint: "test" });
    const rejected = expect(mutation).rejects.toBeInstanceOf(kind === "scope" ? WorkingChatScopeConflictError : ConversationEvidenceDeletionConflictError);
    boundary.release.resolve();
    expect((await sending).delivery.state).toBe("sending");
    await rejected;
    expect((await pool.query("SELECT 1 FROM conversation_message_deletion_tombstones")).rows).toEqual([]);
  });

  it("a competing committed revoke prevents send start from using the prepared scope version", async () => {
    const repository = createPostgresAnswerReplyRepository({ dataSource: pool });
    const prepared = await repository.prepare(preparation());
    const boundary = pauseAfterQuery(sql => sql.includes("INSERT INTO working_chat_scopes"));
    const revoking = createPostgresWorkingChatScopeRepository({ dataSource: boundary.dataSource }).replace({ expectedVersion: 1,
      state: "revoked", groups, updatedBy: "test", at: new Date() });
    await boundary.entered.promise;
    const sending = expect(repository.beginAnswerSend({ deliveryId: prepared.receipt.delivery.id, expectedVersion: 1, at: new Date() }))
      .rejects.toBeInstanceOf(WorkingChatScopeStaleError);
    boundary.release.resolve();
    await revoking;
    await sending;
    expect((await repository.findByIncomingMessage(preparation()))?.delivery.attemptCount).toBe(0);
  });

  it("protects the incoming identity while a safe-notice attempt is unresolved", async () => {
    await seedMessages();
    const repository = createPostgresAnswerReplyRepository({ dataSource: pool });
    const prepared = await repository.prepare({ ...preparation(), sharedChatSources: [], blockedDocumentSourceIds: ["blocked-doc"] });
    const notice = await repository.beginSafeNoticeSend({ deliveryId: prepared.receipt.delivery.id,
      expectedVersion: prepared.receipt.delivery.version, at: new Date() });
    await expect(deleteConversationMessageEvidence({ dataSource: pool, groupId: "group-b", messageId: "feishu:incoming-b", operatorHint: "test" }))
      .rejects.toBeInstanceOf(ConversationEvidenceDeletionConflictError);
    await repository.completeSafeNoticeSend({ deliveryId: notice.delivery.id, expectedVersion: notice.delivery.version,
      at: new Date(), safeNoticeMessageId: "safe-notice" });
    await expect(deleteConversationMessageEvidence({ dataSource: pool, groupId: "group-b", messageId: "feishu:incoming-b", operatorHint: "test" }))
      .resolves.toMatchObject({ status: "deleted" });
  });

  it("persists original shared lineage through two real orchestrated rewrites and refuses reuse after revoke", async () => {
    let clock = new Date("2026-09-09T08:00:00Z");
    const original: FeishuChatHistoryMessage = { messageId: "questionnaire-original", chatId: "group-a", senderId: "human",
      text: "问卷原始正文：先了解使用经历，再询问困难，最后收集建议。", sentAt: new Date(clock.getTime() - 60_000) };
    await createPostgresConversationMessageRepository({ queryable: pool }).upsertMessage({ provider: "feishu",
      providerMessageId: original.messageId, chatId: original.chatId, senderId: original.senderId, text: original.text,
      messageType: "text", mentions: [], sentAt: original.sentAt, rawEventIdempotencyKey: "questionnaire-event" });
    const remoteMessages = new Map<string, FeishuChatHistoryMessage>([[original.messageId, original]]);
    let latestReplyId: string | undefined;
    const assistantReads: string[][] = [];
    const reader: FeishuChatHistoryReader = {
      async listRecentMessages({ chatId }) { return chatId === original.chatId ? [original] : []; },
      async readMessagesByIds({ chatId, messageIds, sender }) {
        // Each rewrite can see only its immediate predecessor, never the first draft directly.
        const selected = messageIds.flatMap(id => {
          const message = remoteMessages.get(id);
          return message?.chatId === chatId && (sender === "assistant" ? id === latestReplyId : message.role !== "assistant") ? [message] : [];
        });
        if (sender === "assistant") assistantReads.push(selected.map(message => message.messageId));
        return selected;
      },
    };
    const scopes = createPostgresWorkingChatScopeRepository({ dataSource: pool });
    const sharedChatVerifier = createSharedChatSourceVerifier({ scopes, reader,
      botAccessChecker: { canAccessChat: async () => true },
      runtimeController: { canReadGroupContext: () => true, canReplyWhenMentioned: () => true } });
    const documentVerifier = { verify: async () => [] };
    const assistantReplies = createAssistantConversationContextProvider({ queryable: pool, reader, verifier: documentVerifier,
      sharedChatVerifier, requireChatProvenance: true });
    const firstContext = createFeishuLiveChatContextProvider({ queryable: pool, reader, now: () => clock,
      sharedChatScopes: scopes, sharedChatVerifier, canReadChat: async () => true });
    // No external scope retrieval on rewrite rounds: all lineage must come from persisted assistant receipts.
    const rewriteContext = createFeishuLiveChatContextProvider({ queryable: pool, reader, now: () => clock,
      assistantReplies, sharedChatVerifier });
    const repository = createPostgresAnswerReplyRepository({ dataSource: pool });
    const replier = { async replyText({ messageId, text }: { messageId: string; text: string }) {
      latestReplyId = `reply-${messageId}`;
      remoteMessages.set(latestReplyId, { messageId: latestReplyId, chatId: "group-b", senderId: "iris", role: "assistant",
        text, sentAt: new Date(clock) });
      return { replyMessageId: latestReplyId };
    } };
    const service = createAnswerReplyDeliveryService({ repository, verifier: documentVerifier, sharedChatVerifier, replier, now: () => clock });
    const persistedBindings = [];
    for (let round = 0; round < 3; round += 1) {
      const expectedContextText = round === 0 ? original.text : `问卷草稿-${round - 1}`;
      const orchestrator = createAnswerDraftOrchestrator({ liveChatContextProvider: round === 0 ? firstContext : rewriteContext,
        contextBuilder: createDocumentRetrievalContextBuilder({ embeddingProfileId: "test",
          embedder: { embedTexts: async texts => texts.map(() => [1]) }, fragments: { searchSimilarFragments: async () => [] }, canReadDocument: async () => false }),
        planner: { plan: async () => ({ taskMode: "direct_task", evidenceState: null, premises: [], proposedAnswer: null,
          missingInformation: [], confidence: null }) },
        model: { async generateAnswerDraft(input) {
          expect(input.promptContext).toContain(expectedContextText);
          if (round > 0) expect(assistantReads.at(-1)).toEqual([`reply-rewrite-${round - 1}`]);
          return { answerText: `问卷草稿-${round}` };
        } },
        renderer: { render: async () => { throw new Error("direct task uses the model boundary"); } },
      });
      const responder = createFeishuMentionAnswerResponder({ botOpenId: "iris", answerDraftOrchestrator: orchestrator,
        answerReplyDeliveryService: service, replier, now: () => clock });
      await expect(responder.maybeRespond({ messageId: `rewrite-${round}`, chatId: "group-b", senderId: "human",
        text: round === 0 ? "@iris 把问卷整理成草稿" : "@iris 把问卷草稿改短", mentions: [{ key: "@iris", openId: "iris" }] }))
        .resolves.toMatchObject({ status: "replied", replyMessageId: `reply-rewrite-${round}` });
      const receipt = await repository.findByIncomingMessage({ provider: "feishu", incomingMessageId: `rewrite-${round}` });
      expect(receipt?.delivery.state).toBe("sent");
      expect(receipt?.delivery.chatProvenanceVersion).toBe(1);
      expect(receipt?.chatSources).toEqual([{ scopeId: "pilot-working-chat", scopeVersion: 1, sourceChatId: "group-a",
        destinationChatId: "group-b", messageId: original.messageId, contentHash: hashSharedChatText(original.text) }]);
      persistedBindings.push(receipt!.chatSources);
      clock = new Date(clock.getTime() + 1_000);
    }
    expect(persistedBindings[2]).toEqual(persistedBindings[0]);
    expect((await assistantReplies.loadRecentReplies({ chatId: "group-b", before: clock })).map(message => message.messageId))
      .toEqual(["reply-rewrite-2"]);
    const readsBeforeRevoke = assistantReads.length;
    await scopes.replace({ expectedVersion: 1, state: "revoked", groups, updatedBy: "test", at: clock });
    expect(await assistantReplies.loadRecentReplies({ chatId: "group-b", before: clock })).toEqual([]);
    expect(assistantReads).toHaveLength(readsBeforeRevoke);
  });

  async function seedMessages() {
    const messages = createPostgresConversationMessageRepository({ queryable: pool });
    for (const suffix of ["a", "b"]) await messages.upsertMessage({ provider: "feishu", providerMessageId: `incoming-${suffix}`,
      chatId: `group-${suffix}`, messageType: "text", text: "original", mentions: [], sentAt: new Date(), rawEventIdempotencyKey: `event-${suffix}` });
  }

  function pauseAfterQuery(matches: (sql: string) => boolean) {
    const entered = deferred(); const release = deferred();
    const dataSource: PostgresAnswerReplyDataSource = {
      query: (sql, values) => pool.query(sql, values),
      async connect() {
        const client = await pool.connect();
        return { release: () => client.release(), async query(sql, values) {
          const result = await client.query(sql, values);
          if (matches(sql)) { entered.resolve(); await release.promise; }
          return result;
        } };
      },
    };
    return { dataSource, entered, release };
  }
});

function sourceFor(destinationChatId: string) {
  const suffix = destinationChatId === "group-a" ? "b" : "a";
  return { scopeId: "pilot-working-chat", scopeVersion: 1, sourceChatId: `group-${suffix}`, destinationChatId,
    messageId: `incoming-${suffix}`, contentHash: hashSharedChatText("original") };
}
function preparation() {
  return { provider: "feishu" as const, incomingMessageId: "incoming-b", chatId: "group-b", replyUuid: createAnswerReplyUuid("incoming-b"),
    safeNoticeUuid: createAnswerReplySafeNoticeUuid("incoming-b"), renderedText: "Shared answer", sourceTraces: [],
    sharedChatSources: [sourceFor("group-b")], at: new Date() };
}
function eventFor(chatId: string): RawEvent {
  const suffix = chatId === "group-a" ? "a" : "b";
  return { provider: "feishu", eventType: "im.message.receive_v1", idempotencyKey: `event-${suffix}`, receivedAt: new Date(), attempts: 0,
    rawBody: { event: { sender: { sender_id: { open_id: "human" } }, message: { message_id: `incoming-${suffix}`, chat_id: chatId,
      message_type: "text", content: JSON.stringify({ text: "@iris what was discussed?" }), mentions: [{ key: "@iris", id: { open_id: "iris" } }] } } } };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
