import { describe, expect, it, vi } from "vitest";
import { createFeishuLiveChatContextProvider } from "../src/memory/live-chat-context-provider.js";

const chatId = "oc-followup";
const oldAt = new Date("2026-09-07T07:33:00Z");
const currentAt = new Date("2026-09-08T10:16:00Z");
const message = (messageId: string, text: string, sentAt = currentAt, extra = {}) => ({
  messageId, chatId, senderId: "ou-member", text, sentAt, ...extra,
});

describe("same-chat continuous source recall", () => {
  it("keeps a verified own answer as assistant conversation while applying final tombstones", async () => {
    const own = message("own", "我建议分成三个部分。", currentAt, { role: "assistant" as const });
    const provider = createFeishuLiveChatContextProvider({
      reader: { listRecentMessages: async () => [message("human", "帮我写个提纲")] },
      queryable: { query: async () => ({ rows: [{ provider_message_id: "deleted-own" }] }) } as never,
      assistantReplies: { loadRecentReplies: async () => [own, { ...own, messageId: "deleted-own" }] },
      now: () => new Date("2026-09-08T11:00:00Z"),
    });
    const context = await provider.loadRecentMessages({ chatId, question: "再简短一点" });
    expect(context.find(m => m.messageId === "own")?.role).toBe("assistant");
    expect(context.some(m => m.messageId === "deleted-own")).toBe(false);
  });

  it("combines the old dated source with the new source for an undated comparison", async () => {
    const newSource = message("new", "新版访谈：先注意什么，体验前的预期和退出时刻。");
    const oldSource = message("old", "旧版访谈：还原两个具体片段和付费意愿。", oldAt);
    const recent = [
      message("anchor", "昨天发的问卷讲了什么？"),
      message("new-label", "这是新的问卷", currentAt, { parentMessageId: "new" }),
      newSource,
    ];
    const reader = {
      listRecentMessages: vi.fn(async (input: { timeRange?: unknown }) => input.timeRange ? [] : recent),
      readMessagesByIds: vi.fn(async ({ messageIds }: { messageIds: string[] }) => messageIds.includes("old-label")
        ? [message("old-label", "这是问卷", oldAt, { parentMessageId: "old" })]
        : [oldSource]),
    };
    const query = vi.fn(async (sql: string) => ({ rows: sql.includes("FROM conversation_messages") ? [{ provider_message_id: "old-label" }] : [] }));
    const context = await createFeishuLiveChatContextProvider({ reader, queryable: { query } as never,
      now: () => new Date("2026-09-08T11:00:00Z") }).loadRecentMessages({ chatId, question: "新问卷和旧问卷有什么区别？" });
    expect(context.map(m => m.messageId)).toContain("old");
    expect(context.map(m => m.messageId)).toContain("new");
    expect(context.find(m => m.messageId === "old")?.text).toContain("还原两个具体片段");
  });

  it("resolves an inherited yesterday against the prior turn's date across midnight", async () => {
    const reader = {
      listRecentMessages: vi.fn(async (input: { timeRange?: unknown }) => input.timeRange ? [] : [message("anchor", "昨天发的问卷讲了什么？")]),
      readMessagesByIds: vi.fn(async () => [message("old", "问卷内容", oldAt)]),
    };
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes("FROM conversation_messages")) {
        expect(params?.slice(0, 3)).toEqual([chatId, new Date("2026-09-06T16:00:00Z"), new Date("2026-09-07T16:00:00Z")]);
        return { rows: [{ provider_message_id: "old" }] };
      }
      return { rows: [] };
    });
    const context = await createFeishuLiveChatContextProvider({ reader, queryable: { query } as never,
      now: () => new Date("2026-09-09T01:00:00Z") }).loadRecentMessages({ chatId, question: "那两版问卷有什么区别？" });
    expect(context.some(m => m.messageId === "old")).toBe(true);
  });

  it("does not resurrect a denied exact ID through an earlier recent-list body", async () => {
    const reader = {
      listRecentMessages: vi.fn(async (input: { timeRange?: unknown }) => input.timeRange ? [] : [
        message("anchor", "昨天问卷讲了什么？"), message("revoked", "问卷 REVOKED BODY", oldAt),
      ]),
      readMessagesByIds: vi.fn(async () => []),
    };
    const query = vi.fn(async (sql: string) => ({ rows: sql.includes("FROM conversation_messages") ? [{ provider_message_id: "revoked" }] : [] }));
    const context = await createFeishuLiveChatContextProvider({ reader, queryable: { query } as never,
      now: () => new Date("2026-09-08T11:00:00Z") }).loadRecentMessages({ chatId, question: "两版问卷有什么区别？" });
    expect(context.some(m => m.messageId === "revoked")).toBe(false);
  });

  it.each([
    "什么是净推荐值？",
    "哪个国家面积最大？",
    "你觉得什么是净推荐值？",
  ])("does not reuse an unrelated dated topic for the ordinary question %s", async (question) => {
    const reader = {
      listRecentMessages: vi.fn(async () => [message("anchor", "昨天问卷讲了什么？")]),
      readMessagesByIds: vi.fn(async () => []),
    };
    const query = vi.fn(async () => ({ rows: [] }));
    await createFeishuLiveChatContextProvider({ reader, queryable: { query } as never,
      now: () => new Date("2026-09-08T11:00:00Z") }).loadRecentMessages({ chatId, question });
    expect(reader.listRecentMessages).toHaveBeenCalledTimes(1);
    expect(reader.listRecentMessages).toHaveBeenCalledWith({ chatId, limit: 100 });
    expect(reader.readMessagesByIds).not.toHaveBeenCalled();
    expect(query.mock.calls).toHaveLength(1);
  });

  it("does not use an assistant message as a historical date anchor", async () => {
    const reader = {
      listRecentMessages: vi.fn(async () => [
        message("assistant-anchor", "昨天问卷讲了什么？", currentAt, { role: "assistant" as const }),
      ]),
      readMessagesByIds: vi.fn(async () => []),
    };
    const query = vi.fn(async () => ({ rows: [] }));

    await createFeishuLiveChatContextProvider({ reader, queryable: { query } as never,
      now: () => new Date("2026-09-08T11:00:00Z") }).loadRecentMessages({ chatId, question: "这版有什么不同？" });

    expect(reader.listRecentMessages).toHaveBeenCalledTimes(1);
    expect(reader.readMessagesByIds).not.toHaveBeenCalled();
    expect(query.mock.calls).toHaveLength(1);
  });

  it("shares eight candidate and eight parent reads across two distinct dated anchors", async () => {
    const batches: string[][] = [];
    const reader = {
      listRecentMessages: async (input: { timeRange?: unknown }) => input.timeRange ? [] : [
        message("yesterday", "昨天问卷讲了什么？"), message("before", "前天问卷讲了什么？"),
      ],
      readMessagesByIds: async ({ messageIds }: { messageIds: string[] }) => {
        batches.push(messageIds);
        return messageIds.map(id => message(id, "问卷内容", new Date(id.startsWith("6") ? "2026-09-06T08:00:00Z" : "2026-09-07T08:00:00Z"),
          id.endsWith("-parent") ? {} : { parentMessageId: `${id}-parent` }));
      },
    };
    const query = vi.fn(async (sql: string, params?: unknown[]) => ({ rows: sql.includes("FROM conversation_messages")
      ? Array.from({ length: 8 }, (_, i) => ({ provider_message_id: `${(params?.[1] as Date).toISOString().startsWith("2026-09-05") ? "6" : "7"}-${i}` })) : [] }));
    const result = await createFeishuLiveChatContextProvider({ reader, queryable: { query } as never,
      now: () => new Date("2026-09-08T11:00:00Z") }).loadRecentMessages({ chatId, question: "两版问卷区别是什么？" });
    expect(batches.filter(batch => !batch[0]?.endsWith("-parent")).flat()).toHaveLength(8);
    expect(batches.filter(batch => batch[0]?.endsWith("-parent")).flat()).toHaveLength(8);
    expect(result.some(m => m.messageId?.startsWith("6-"))).toBe(true);
    expect(result.some(m => m.messageId?.startsWith("7-"))).toBe(true);
  });
});
