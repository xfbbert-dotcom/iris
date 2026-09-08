import { randomUUID } from "node:crypto";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { createFeishuLiveChatContextProvider } from "../src/memory/live-chat-context-provider.js";
import { defaultMigrationsDir, runMigrations } from "../src/database/migrate.js";
import { createAssistantConversationContextProvider } from "../src/memory/assistant-conversation-context.js";

const databaseUrl = process.env.IRIS_TEST_DATABASE_URL?.trim();
const databaseTests = databaseUrl ? describe : describe.skip;

databaseTests("dated history candidate SQL with Postgres", () => {
  it("selects only recent sent same-chat assistant identities from the real delivery ledger", async () => {
    const pool = new pg.Pool({ connectionString: databaseUrl });
    const db = await pool.connect();
    const group = `oc-continuity-${randomUUID()}`;
    const before = new Date("2026-09-08T12:00:00Z");
    try {
      await runMigrations({ client: db, migrationsDir: defaultMigrationsDir() });
      await db.query("BEGIN");
      for (const [suffix, chat, state, sentAt] of [
        ["own", group, "sent", "2026-09-08T11:00:00Z"],
        ["foreign", `${group}-other`, "sent", "2026-09-08T11:30:00Z"],
        ["future", group, "sent", "2026-09-08T13:00:00Z"],
        ["expired", group, "sent", "2026-09-06T13:00:00Z"],
        ["prepared", group, "prepared", "2026-09-08T11:59:00Z"],
      ]) {
        await db.query(`INSERT INTO answer_reply_deliveries
          (id,provider,incoming_message_id,chat_id,reply_uuid,safe_notice_uuid,state,prepared_reply_text,
           rendered_reply_fingerprint,semantic_fingerprint,reply_message_id,created_at,updated_at,sent_at)
          VALUES ($1,'feishu',$1,$2,$3,$4,$5,$6,$7,$7,$8,$9,$9,$9)`,
        [`${group}-${suffix}`, chat, randomUUID(), randomUUID(), state, state === "prepared" ? "CACHED NEVER READ" : null,
          "a".repeat(64), `om-${suffix}`, sentAt]);
      }
      const reads: string[][] = [];
      const provider = createAssistantConversationContextProvider({ queryable: db,
        verifier: { verify: async () => [] },
        reader: { listRecentMessages: async () => [], readMessagesByIds: async ({ messageIds, sender }) => {
          expect(sender).toBe("assistant"); reads.push(messageIds);
          return messageIds.map(messageId => ({ messageId, chatId: group, senderId: "cli-iris", role: "assistant" as const,
            text: "Fresh generic draft", sentAt: new Date("2026-09-08T11:00:00Z") }));
        } },
      });
      expect(await provider.loadRecentReplies({ chatId: group, before })).toEqual([
        expect.objectContaining({ messageId: "om-own", role: "assistant", text: "Fresh generic draft" }),
      ]);
      expect(reads).toEqual([["om-own"]]);
    } finally { await db.query("ROLLBACK"); db.release(); await pool.end(); }
  });

  it("selects only the dated same-chat topic identity, excluding tombstones and using a fresh body", async () => {
    const pool = new pg.Pool({ connectionString: databaseUrl });
    const db = await pool.connect();
    const group = `oc-history-${randomUUID()}`;
    const id = (suffix: string) => `${group}-${suffix}`;
    try {
      await runMigrations({ client: db, migrationsDir: defaultMigrationsDir() });
      await db.query("BEGIN");
      for (const [suffix, chatId, sentAt, text] of [
        ["match", group, "2026-09-07T07:33:00Z", "问卷 OLD CACHED BODY"],
        ["foreign", `${group}-foreign`, "2026-09-07T07:35:00Z", "问卷 FOREIGN"],
        ["old", group, "2026-09-06T07:35:00Z", "问卷 OLD DATE"],
        ["deleted", group, "2026-09-07T07:35:00Z", "问卷 DELETED"],
        ["unrelated", group, "2026-09-07T07:35:00Z", "无关闲聊"],
      ]) {
        await db.query(`INSERT INTO conversation_messages
          (id,provider,provider_message_id,chat_id,sender_id,message_type,text,sent_at,raw_event_idempotency_key)
          VALUES ($1,'feishu',$2,$3,'ou-author','post',$4,$5,$6)`,
        [`feishu:${id(suffix!)}`, id(suffix!), chatId, text, sentAt, `event-${id(suffix!)}`]);
      }
      await db.query(`INSERT INTO conversation_message_deletion_tombstones
        (provider,provider_message_id,conversation_message_id,chat_id)
        VALUES ('feishu',$1,$2,$3)`, [id("deleted"), `feishu:${id("deleted")}`, group]);
      const readIds: string[][] = [];
      const provider = createFeishuLiveChatContextProvider({
        queryable: db,
        now: () => new Date("2026-09-08T09:57:00Z"),
        reader: {
          listRecentMessages: async () => [],
          readMessagesByIds: async ({ messageIds }) => {
            readIds.push(messageIds);
            return messageIds.map(messageId => ({ messageId, chatId: group, senderId: "ou-author", text: "问卷 FRESH VERIFIED BODY", sentAt: new Date("2026-09-07T07:33:00Z") }));
          },
        },
      });
      const context = await provider.loadRecentMessages({ chatId: group, question: "昨天发的问卷主要讲了什么？" });
      expect(readIds).toEqual([[id("match")]]);
      expect(context).toHaveLength(1);
      expect(context[0]?.text).toContain("FRESH VERIFIED BODY");
      expect(JSON.stringify(context)).not.toMatch(/CACHED|FOREIGN|OLD DATE|DELETED/);
    } finally {
      await db.query("ROLLBACK");
      db.release();
      await pool.end();
    }
  });
});
