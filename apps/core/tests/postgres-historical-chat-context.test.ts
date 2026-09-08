import { randomUUID } from "node:crypto";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { createFeishuLiveChatContextProvider } from "../src/memory/live-chat-context-provider.js";
import { defaultMigrationsDir, runMigrations } from "../src/database/migrate.js";

const databaseUrl = process.env.IRIS_TEST_DATABASE_URL?.trim();
const databaseTests = databaseUrl ? describe : describe.skip;

databaseTests("dated history candidate SQL with Postgres", () => {
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
