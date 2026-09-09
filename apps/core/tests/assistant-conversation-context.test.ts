import { describe, expect, it, vi } from "vitest";
import { createAssistantConversationContextProvider } from "../src/memory/assistant-conversation-context.js";

const ownReply = { messageId: "own", chatId: "oc-group", senderId: "cli-iris", role: "assistant" as const,
  text: "三个访谈问题：先了解使用经历，再询问困难，最后收集建议。", sentAt: new Date("2026-09-08T11:00:00Z") };
const delivery = { delivery_id: "delivery", reply_message_id: "own" };
const source = { delivery_id: "delivery", document_source_id: "source", document_snapshot_id: "snapshot",
  cross_group_grant_id: null, cross_group_grant_version: null, cross_group_grantor_group_id: null, cross_group_grantee_group_id: null };

function setup(traces = [source], outcome = "allowed") {
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    if (sql.includes("FROM answer_reply_deliveries")) {
      expect(params?.[0]).toBe("oc-group");
      return { rows: [delivery] };
    }
    if (sql.includes("FROM answer_reply_source_traces")) return { rows: traces };
    expect(sql).toContain("FROM answer_reply_chat_source_traces");
    return { rows: [] };
  });
  const reader = { listRecentMessages: async () => [], readMessagesByIds: vi.fn(async () => [ownReply]) };
  const verifier = { verify: vi.fn(async () => traces.length === 0 ? [] : [{ documentSourceId: "source", outcome }]) };
  return { reader, verifier, provider: createAssistantConversationContextProvider({ queryable: { query } as never, reader, verifier: verifier as never }) };
}

describe("own sent-answer conversational continuity", () => {
  it("uses a fresh own-reply identity, not stored generated text, as assistant context", async () => {
    const { provider, reader } = setup([]);
    const result = await provider.loadRecentReplies({ chatId: "oc-group", before: new Date("2026-09-08T12:00:00Z") });
    expect(result).toEqual([ownReply]);
    expect(reader.readMessagesByIds).toHaveBeenCalledWith({ chatId: "oc-group", messageIds: ["own"], sender: "assistant" });
  });

  it.each(["denied", "error"])("does not fetch a previous answer whose source is %s", async outcome => {
    const { provider, reader } = setup([source], outcome);
    expect(await provider.loadRecentReplies({ chatId: "oc-group", before: new Date("2026-09-08T12:00:00Z") })).toEqual([]);
    expect(reader.readMessagesByIds).not.toHaveBeenCalled();
  });

  it("does not reuse a grant-backed answer without current exact-grant validation", async () => {
    const { provider, reader } = setup([{ ...source, cross_group_grant_id: "grant", cross_group_grant_version: 1,
      cross_group_grantor_group_id: "oc-old", cross_group_grantee_group_id: "oc-group" }] as never);
    expect(await provider.loadRecentReplies({ chatId: "oc-group", before: new Date("2026-09-08T12:00:00Z") })).toEqual([]);
    expect(reader.readMessagesByIds).not.toHaveBeenCalled();
  });

  it("rejects wrong-chat, unknown-ID, human and expired answers returned by a reader", async () => {
    const { provider, reader } = setup([]);
    reader.readMessagesByIds.mockResolvedValue([
      { ...ownReply, chatId: "oc-other" }, { ...ownReply, messageId: "other" },
      { ...ownReply, role: undefined }, { ...ownReply, sentAt: new Date("2026-09-06T12:00:00Z") },
    ] as never);
    expect(await provider.loadRecentReplies({ chatId: "oc-group", before: new Date("2026-09-08T12:00:00Z") })).toEqual([]);
  });

  it.each([false, true])("deduplicates identical fragment grants and rejects conflicting identities (conflict=%s)", async conflict => {
    const first = { ...source, cross_group_grant_id: "grant", cross_group_grant_version: 1,
      cross_group_grantor_group_id: "oc-old", cross_group_grantee_group_id: "oc-group" };
    const second = { ...first, cross_group_grant_version: conflict ? 2 : 1 };
    const verify = vi.fn(async (input: { crossGroupGrantBindings?: readonly unknown[] }) => {
      expect(input.crossGroupGrantBindings).toHaveLength(1);
      return [{ documentSourceId: "source", outcome: "allowed" as const }];
    });
    const provider = createAssistantConversationContextProvider({
      queryable: { query: async (sql: string) => {
        if (sql.includes("FROM answer_reply_deliveries")) return { rows: [delivery] };
        if (sql.includes("FROM answer_reply_source_traces")) return { rows: [first, second] };
        expect(sql).toContain("FROM answer_reply_chat_source_traces");
        return { rows: [] };
      } } as never,
      grants: { validateExact: async () => true }, verifier: { verify },
      reader: { listRecentMessages: async () => [], readMessagesByIds: async () => [ownReply] },
    });
    const replies = await provider.loadRecentReplies({ chatId: "oc-group", before: new Date("2026-09-08T12:00:00Z") });
    expect(replies).toHaveLength(conflict ? 0 : 1);
    if (conflict) expect(verify).not.toHaveBeenCalled();
  });
});
