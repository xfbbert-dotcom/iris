import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
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

const databaseUrl = process.env.IRIS_TEST_DATABASE_URL?.trim();
const runIfDatabase = databaseUrl ? describe : describe.skip;
const groups = [{ chatId: "group-a", name: "A" }, { chatId: "group-b", name: "B" }];

runIfDatabase("shared-chat answer transaction boundaries with disposable PostgreSQL", () => {
  const schema = `shared_answer_${randomUUID().replaceAll("-", "")}`;
  let admin: pg.Pool;
  let pool: pg.Pool;
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: databaseUrl });
    const client = await admin.connect();
    try {
      await client.query(`CREATE SCHEMA ${schema}`);
      await client.query(`SET search_path TO ${schema}, public`);
      await runMigrations({ client, migrationsDir: defaultMigrationsDir() });
    } finally { client.release(); }
    // Statement timeout also bounds the pre-fix application-level lock cycle.
    pool = new pg.Pool({ connectionString: databaseUrl,
      options: `-c search_path=${schema},public -c statement_timeout=3000`, max: 12 });
  }, 60_000);
  afterAll(async () => {
    await pool?.end();
    if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
  });
  beforeEach(async () => {
    // The entire pool is restricted to this random test schema. Trace facts are append-only.
    await pool.query("TRUNCATE answer_reply_deliveries CASCADE");
    await pool.query("DELETE FROM working_chat_scopes");
    await pool.query("DELETE FROM conversation_messages");
    await pool.query("DELETE FROM conversation_message_deletion_tombstones");
    await pool.query(`UPDATE runtime_control_state SET desired_global_enabled = true, disabled_group_ids = '{}',
      capabilities = capabilities || '{"readGroupContext":true,"replyWhenMentioned":true}'::jsonb`);
    await createPostgresWorkingChatScopeRepository({ dataSource: pool }).replace({ expectedVersion: 0,
      state: "active", groups, updatedBy: "test", at: new Date() });
  });

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
