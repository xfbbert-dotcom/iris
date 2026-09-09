import { describe, expect, it } from "vitest";
import { createFeishuLiveChatContextProvider } from "../src/memory/live-chat-context-provider.js";
import type { FeishuChatHistoryMessage } from "../src/feishu/feishu-chat-history-reader.js";
import type { Queryable } from "../src/documents/document-fragment-repository.js";
import { selectTopicAwareChatWindow } from "../src/memory/topic-aware-chat-window.js";

const now = new Date("2026-09-09T10:00:00Z");
const scope = { id: "pilot-working-chat", version: 1, state: "active" as const,
  groups: [{ chatId: "group-a", name: "研究群" }, { chatId: "group-b", name: "产品群" }], updatedBy: "operator", updatedAt: now };
function message(messageId: string, chatId: string, text: string, extra = {}): FeishuChatHistoryMessage {
  return { messageId, chatId, text, senderId: "author", sentAt: new Date("2026-09-08T08:00:00Z"), ...extra };
}
function fixture(input: { denied?: boolean; disabled?: boolean; revoked?: boolean; recent?: FeishuChatHistoryMessage[]; originals?: FeishuChatHistoryMessage[];
  replies?: FeishuChatHistoryMessage[]; groups?: typeof scope.groups; rows?: {chat_id:string;provider_message_id:string}[] } = {}) {
  const readChats: string[] = [];
  const verified: unknown[] = [];
  const queries: unknown[][] = [];
  const configuredScope = { ...scope, groups: input.groups ?? scope.groups };
  const originals = input.originals ?? [message("original", "group-a", "12 个主问题：访谈问卷讨论用户实际体验。"),
    message("label", "group-a", "这是问卷", { parentMessageId: "original" })];
  const queryable: Queryable = { async query<T>(sql: string, params?: unknown[]) {
    if (sql.includes("FROM conversation_messages")) {
      queries.push(params ?? []);
      return { rows: (input.rows ?? [{ chat_id: "group-a", provider_message_id: "label" }]) as T[] };
    }
    return { rows: [] };
  } };
  const provider = createFeishuLiveChatContextProvider({ queryable, now: () => now,
    sharedChatScopes: { async resolveForChat(chatId) { return configuredScope.groups.some(g => g.chatId === chatId) ? configuredScope : undefined; }, async validateExact() { return !input.revoked; } },
    canReadChat: async chatId => !(input.disabled && chatId === "group-a"),
    sharedChatVerifier: { async verify(request) { verified.push(request); return !input.revoked; } },
    assistantReplies: { async loadRecentReplies() { return input.replies ?? []; } },
    reader: {
      async listRecentMessages({ chatId, timeRange }) { readChats.push(chatId); return (input.recent ?? []).filter(m => m.chatId === chatId
        && (timeRange === undefined || m.sentAt >= timeRange.start && m.sentAt < timeRange.end)); },
      async readMessagesByIds({ chatId, messageIds }) { readChats.push(chatId); return input.denied ? [] : originals.filter(m => m.chatId === chatId && messageIds.includes(m.messageId)); },
    },
  });
  return { provider, readChats, verified, queries };
}

describe("shared working chat context", () => {
  it("recalls an ordinary other-group original and its label with fresh source identity", async () => {
    const { provider, verified, queries } = fixture();
    const result = await provider.loadRecentMessages({ chatId: "group-b", question: "研究群之前的问卷主要讨论了什么？" });
    expect(result.map(m => m.messageId)).toEqual(["original", "label"]);
    expect(result[0]).toMatchObject({ sourceChatId: "group-a", sourceChatName: "研究群", sourceSentAt: "2026-09-08T08:00:00.000Z",
      sharedChatSource: { scopeId: "pilot-working-chat", scopeVersion: 1, sourceChatId: "group-a", destinationChatId: "group-b", messageId: "original" } });
    expect(result[0]?.sharedChatSource?.contentHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(verified).toHaveLength(1);
    expect(queries.flat()).toContainEqual(new Date("2026-08-10T10:00:00Z"));
  });

  it("can recap another group's recent discussion without a keyword or date", async () => {
    const { provider } = fixture({ recent: [message("recent", "group-a", "我们刚刚决定周五交付演示。")], rows: [] });
    const result = await provider.loadRecentMessages({ chatId: "group-b", question: "其他群最近聊了什么？" });
    expect(result.some(m => m.sourceChatId === "group-a" && m.text.includes("周五交付"))).toBe(true);
  });

  it("keeps a shared recap available through both windows despite a busier destination", async () => {
    const recent = [message("external-recent", "group-a", "周五交付演示。"),
      ...Array.from({ length: 30 }, (_, i) => message(`local-${i}`, "group-b", `收到 ${i}`, { sentAt: new Date(now.getTime() - i * 1000) }))];
    const { provider } = fixture({ recent, rows: [] });
    const result = await provider.loadRecentMessages({ chatId: "group-b", question: "其他群最近聊了什么？" });
    expect(result.some(m => m.messageId === "external-recent")).toBe(true);
    expect(selectTopicAwareChatWindow(result, "其他群最近聊了什么？", 10).some(m => m.messageId === "external-recent")).toBe(true);
  });

  it("omits a prior assistant's external source material for a local-only question", async () => {
    const { provider } = fixture({ replies: [message("own", "group-b", "前次外群材料的草稿", { role: "assistant", underlyingChatSources: [
      { scopeId: "pilot-working-chat", scopeVersion: 1, sourceChatId: "group-a", destinationChatId: "group-b", messageId: "original", contentHash: "a".repeat(64) },
    ] })] });
    expect(await provider.loadRecentMessages({ chatId: "group-b", question: "只根据本群总结问卷" })).toEqual([]);
  });

  it("limits named source recall to that member group even when other members match", async () => {
    const { provider, readChats } = fixture({ groups: [...scope.groups, { chatId: "group-c", name: "工程群" }],
      rows: [{ chat_id: "group-a", provider_message_id: "label" }, { chat_id: "group-c", provider_message_id: "foreign-label" }] });
    const result = await provider.loadRecentMessages({ chatId: "group-b", question: "研究群问卷讲什么？" });
    expect(result.map(m => m.sourceChatId)).toEqual(["group-a", "group-a"]);
    expect(readChats).not.toContain("group-c");
  });

  it.each(["本群的问卷讲什么？", "只根据本群总结问卷", "产品群之前的问卷讲什么？"])("honors explicit destination-only scope: %s", async question => {
    const { provider, readChats, queries } = fixture();
    expect(await provider.loadRecentMessages({ chatId: "group-b", question })).toEqual([]);
    expect(readChats).not.toContain("group-a");
    expect(queries).toEqual([]);
  });

  it("uses the requested local-calendar day for a keyword-free shared recap", async () => {
    const { provider } = fixture({ recent: [message("yesterday", "group-a", "昨天确定周五交付。"),
      message("today", "group-a", "今天的新结论", { sentAt: now })], rows: [] });
    const result = await provider.loadRecentMessages({ chatId: "group-b", question: "研究群昨天聊了什么？" });
    expect(result.map(m => m.messageId)).toEqual(["yesterday"]);
  });

  it("bounds long source bodies together without clipping their provenance", async () => {
    const recent = Array.from({ length: 5 }, (_, i) => message(`long-${i}`, i % 2 ? "group-b" : "group-a", "工作讨论".repeat(3000)));
    const { provider } = fixture({ recent, rows: [] });
    const result = await provider.loadRecentMessages({ chatId: "group-b", question: "其他群最近聊了什么？" });
    expect(result.reduce((total, m) => total + m.text.length, 0)).toBeLessThanOrEqual(24000);
    expect(result.every(m => m.text.length <= 8000)).toBe(true);
    expect(result.filter(m => m.sourceChatId === "group-a").map(m => m.sharedChatSource?.messageId).sort()).toEqual(["long-0", "long-2", "long-4"]);
  });

  it.each([{ denied: true }, { disabled: true }, { revoked: true }])("withholds unavailable shared sources: %j", async flags => {
    const { provider } = fixture(flags);
    expect(await provider.loadRecentMessages({ chatId: "group-b", question: "研究群问卷" })).toEqual([]);
  });

  it("never reads an outsider returned by a corrupted candidate query", async () => {
    const { provider, readChats } = fixture({ rows: [{ chat_id: "group-c", provider_message_id: "foreign" }] });
    expect(await provider.loadRecentMessages({ chatId: "group-b", question: "问卷" })).toEqual([]);
    expect(readChats).not.toContain("group-c");
  });

  it("shares one twenty-message output window across groups", async () => {
    const { provider } = fixture({ recent: Array.from({ length: 40 }, (_, i) => message(`recent-${i}`, i % 2 ? "group-a" : "group-b", `讨论 ${i}`,
      { sentAt: new Date(now.getTime() - i * 1000) })), rows: [] });
    const result = await provider.loadRecentMessages({ chatId: "group-b", question: "其他群最近聊了什么？" });
    expect(result).toHaveLength(20);
    expect(new Set(result.map(m => m.sourceChatId))).toEqual(new Set(["group-a", "group-b"]));
  });

  it("shares the eight candidate and eight parent reads between destination history and external recall", async () => {
    const readIds: string[] = [];
    const queryable: Queryable = { async query<T>(sql: string, params?: unknown[]) {
      if (!sql.includes("FROM conversation_messages")) return { rows: [] };
      const group = Array.isArray(params?.[0]) ? params[0][0] as string : params?.[0] as string;
      return { rows: Array.from({ length: params?.[5] as number }, (_, i) => ({ chat_id: group, provider_message_id: `candidate-${group}-${i}` })) as T[] };
    } };
    const provider = createFeishuLiveChatContextProvider({ queryable, now: () => now,
      sharedChatScopes: { async resolveForChat() { return scope; }, async validateExact() { return true; } },
      canReadChat: async () => true, sharedChatVerifier: { async verify() { return true; } },
      reader: { async listRecentMessages() { return []; }, async readMessagesByIds({ chatId, messageIds }) {
        readIds.push(...messageIds);
        return messageIds.map(id => message(id, chatId, id.startsWith("candidate") ? "这是问卷" : "问卷原始内容",
          id.startsWith("candidate") ? { parentMessageId: id.replace("candidate", "parent") } : {}));
      } },
    });
    const result = await provider.loadRecentMessages({ chatId: "group-b", question: "昨天问卷主要讲什么？" });
    expect(readIds.filter(id => id.startsWith("candidate"))).toHaveLength(8);
    expect(readIds.filter(id => id.startsWith("parent"))).toHaveLength(8);
    expect(result).toHaveLength(16);
    expect(new Set(result.map(m => m.sourceChatId))).toEqual(new Set(["group-a", "group-b"]));
  });
});
