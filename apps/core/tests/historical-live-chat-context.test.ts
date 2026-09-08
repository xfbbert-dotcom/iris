import { describe, expect, it, vi } from "vitest";
import { createFeishuLiveChatContextProvider } from "../src/memory/live-chat-context-provider.js";

const chatId = "oc-current";
const now = () => new Date("2026-09-08T09:57:00Z");
const question = "昨天发的问卷主要讲了什么？";
function message(messageId: string, text: string, extra = {}) {
  return { messageId, text, chatId, senderId: "ou-author", sentAt: new Date("2026-09-07T07:44:00Z"), ...extra };
}

describe("dated same-chat history context", () => {
  it("recovers a topic label and its live parent beyond the latest hundred messages without using stored text", async () => {
    const reader = {
      listRecentMessages: vi.fn(async () => Array.from({ length: 100 }, (_, i) => message(`recent-${i}`, i > 92 ? "问卷在哪？" : "收到，谢谢", { sentAt: new Date(1788790000000 + i) }))),
      readMessagesByIds: vi.fn(async ({ messageIds }: { messageIds: string[] }) => messageIds.includes("label")
        ? [message("label", "这是问卷", { parentMessageId: "original", rootMessageId: "original" })]
        : [message("original", "12个主问题：还原用户体验、投入和困惑。", { sentAt: new Date("2026-09-07T07:33:00Z") })]),
    };
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes("FROM conversation_messages")) {
        expect(params?.slice(0, 3)).toEqual([chatId, new Date("2026-09-06T16:00:00Z"), new Date("2026-09-07T16:00:00Z")]);
        expect(params?.[3]).toContain("问卷");
        return { rows: [{ provider_message_id: "label", text: "DO NOT TRUST CACHED CONTENT" }] };
      }
      return { rows: [] };
    });
    const provider = createFeishuLiveChatContextProvider({ reader, queryable: { query } as never, now });

    const context = await provider.loadRecentMessages({ chatId, question });

    expect(context.some(m => m.messageId === "original" && m.text.includes("12个主问题"))).toBe(true);
    expect(context.find(m => m.messageId === "label")?.parentMessageId).toBe("original");
    expect(JSON.stringify(context)).not.toContain("CACHED CONTENT");
    expect(context).toHaveLength(20);
    expect(reader.listRecentMessages).toHaveBeenCalledWith({ chatId, limit: 100, timeRange: { start: new Date("2026-09-06T16:00:00Z"), end: new Date("2026-09-07T16:00:00Z") } });
    expect(reader.readMessagesByIds).toHaveBeenCalledTimes(2);
    expect(context.find(m => m.messageId === "original")?.text).toContain("2026-09-07");
  });

  it("does not expose cached candidates when live revalidation fails", async () => {
    const reader = { listRecentMessages: async () => [], readMessagesByIds: async () => { throw new Error("history unavailable"); } };
    const query = vi.fn(async () => ({ rows: [{ provider_message_id: "original", text: "stale private body" }] }));
    const provider = createFeishuLiveChatContextProvider({ reader, queryable: { query } as never, now });
    await expect(provider.loadRecentMessages({ chatId, question })).rejects.toThrow("history unavailable");
  });

  it("lets an omitted revalidated candidate revoke its earlier day-list body", async () => {
    const reader = { listRecentMessages: async () => [message("revoked", "问卷 BEFORE REVOCATION")], readMessagesByIds: async () => [] };
    const query = vi.fn(async (sql: string) => ({ rows: sql.includes("FROM conversation_messages") ? [{ provider_message_id: "revoked" }] : [] }));
    const provider = createFeishuLiveChatContextProvider({ reader, queryable: { query } as never, now });
    expect(await provider.loadRecentMessages({ chatId, question })).toEqual([]);
  });

  it("excludes foreign, outside-date and tombstoned historical parents", async () => {
    const reader = {
      listRecentMessages: async () => [],
      readMessagesByIds: async ({ messageIds }: { messageIds: string[] }) => messageIds.includes("label")
        ? [message("label", "这是问卷", { parentMessageId: "deleted" }), message("foreign", "别群问卷", { chatId: "oc-other" }), message("old", "前天问卷", { sentAt: new Date("2026-09-06T07:33:00Z") })]
        : [message("deleted", "已删除的问卷")],
    };
    const query = vi.fn(async (sql: string) => ({ rows: sql.includes("FROM conversation_messages") ? [{ provider_message_id: "label" }] : [{ provider_message_id: "deleted" }] }));
    const provider = createFeishuLiveChatContextProvider({ reader, queryable: { query } as never, now });
    const context = await provider.loadRecentMessages({ chatId, question });
    expect(context.map(m => m.messageId)).toEqual(["label"]);
    expect(JSON.stringify(context)).not.toMatch(/别群|前天问卷|已删除/);
  });

  it("keeps undated live context on the existing read-only recent path", async () => {
    const reader = { listRecentMessages: vi.fn(async () => [message("recent", "刚聊的内容")]), readMessagesByIds: vi.fn() };
    const query = vi.fn(async (_sql: string) => ({ rows: [] }));
    const provider = createFeishuLiveChatContextProvider({ reader, queryable: { query } as never, now });
    expect(await provider.loadRecentMessages({ chatId, question: "刚才聊了什么？" })).toEqual([{ speaker: "ou-author", text: "刚聊的内容", messageId: "recent" }]);
    expect(reader.readMessagesByIds).not.toHaveBeenCalled();
    expect(query.mock.calls.every(call => !call[0]?.includes("FROM conversation_messages"))).toBe(true);
  });
});
