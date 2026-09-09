import { randomUUID } from "node:crypto";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { createFeishuLiveChatContextProvider } from "../src/memory/live-chat-context-provider.js";
import { defaultMigrationsDir, runMigrations } from "../src/database/migrate.js";

const databaseUrl = process.env.IRIS_TEST_DATABASE_URL?.trim();
const databaseTests = databaseUrl ? describe : describe.skip;

databaseTests("shared working-chat candidate SQL in PostgreSQL", () => {
  it("only recalls scoped recent topic identities and never uses cached bodies", async () => {
    const pool = new pg.Pool({ connectionString: databaseUrl });
    const db = await pool.connect();
    const schema = `shared_context_${randomUUID().replaceAll("-", "")}`;
    const prefix = `shared-${randomUUID()}`;
    const sourceChatId = `${prefix}-source`;
    const destinationChatId = `${prefix}-destination`;
    const now = new Date("2026-09-09T10:00:00Z");
    const readIds: string[] = [];
    try {
      await db.query(`CREATE SCHEMA ${schema}`);
      await db.query(`SET search_path TO ${schema}, public`);
      await runMigrations({ client: db, migrationsDir: defaultMigrationsDir() });
      await db.query("BEGIN");
      for (const [suffix, group, at, text] of [
        ["match", sourceChatId, "2026-09-08T08:00:00Z", "问卷 OLD CACHED BODY"],
        ["foreign", `${prefix}-foreign`, "2026-09-08T08:00:00Z", "问卷 FOREIGN"],
        ["old", sourceChatId, "2026-08-01T08:00:00Z", "问卷 OLD DATE"],
        ["deleted", sourceChatId, "2026-09-08T08:00:00Z", "问卷 DELETED"],
        ["irrelevant", sourceChatId, "2026-09-08T08:00:00Z", "收到谢谢"],
      ]) {
        await db.query(`INSERT INTO conversation_messages
          (id,provider,provider_message_id,chat_id,sender_id,message_type,text,sent_at,raw_event_idempotency_key)
          VALUES ($1,'feishu',$2,$3,'author','post',$4,$5,$6)`,
        [`feishu:${prefix}-${suffix}`, `${prefix}-${suffix}`, group, text, at, `event-${prefix}-${suffix}`]);
      }
      await db.query(`INSERT INTO conversation_message_deletion_tombstones
        (provider,provider_message_id,conversation_message_id,chat_id) VALUES ('feishu',$1,$2,$3)`,
      [`${prefix}-deleted`, `feishu:${prefix}-deleted`, sourceChatId]);
      const provider = createFeishuLiveChatContextProvider({ queryable: db, now: () => now,
        sharedChatScopes: {
          async resolveForChat(chatId) { return chatId === destinationChatId ? { id: "pilot-working-chat", version: 1, state: "active",
            groups: [{ chatId: sourceChatId, name: "研究群" }, { chatId: destinationChatId, name: "产品群" }], updatedBy: "test", updatedAt: now } : undefined; },
          async validateExact() { return true; },
        },
        canReadChat: async () => true, sharedChatVerifier: { async verify() { return true; } },
        reader: { async listRecentMessages() { return []; }, async readMessagesByIds({ chatId, messageIds }) {
          readIds.push(...messageIds);
          return messageIds.map(messageId => ({ messageId, chatId, senderId: "author", text: "问卷 FRESH VERIFIED BODY", sentAt: new Date("2026-09-08T08:00:00Z") }));
        } },
      });
      const context = await provider.loadRecentMessages({ chatId: destinationChatId, question: "研究群之前的问卷讲什么？" });
      expect(readIds).toEqual([`${prefix}-match`]);
      expect(context).toHaveLength(1);
      expect(context[0]?.text).toBe("问卷 FRESH VERIFIED BODY");
      expect(context[0]?.sharedChatSource?.sourceChatId).toBe(sourceChatId);
      expect(JSON.stringify(context)).not.toMatch(/CACHED|FOREIGN|OLD DATE|DELETED/);
    } finally {
      await db.query("ROLLBACK");
      await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      db.release();
      await pool.end();
    }
  });
});
