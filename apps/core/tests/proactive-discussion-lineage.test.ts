import { describe, expect, it } from "vitest";
import { createAssistantConversationContextProvider } from "../src/memory/assistant-conversation-context.js";
import { createFeishuLiveChatContextProvider } from "../src/memory/live-chat-context-provider.js";
import { createAnswerDraftOrchestrator } from "../src/agent/answer-draft-orchestrator.js";
import { createDocumentRetrievalContextBuilder } from "../src/memory/document-retrieval-context.js";
import { hashLocalMessageText } from "../src/memory/local-message-source.js";
import { createPdReceiptProvider } from "../src/proactive-discussion/receipt-provider.js";
import { createPdSourceRef } from "../src/proactive-discussion/contracts.js";

const chatId = "oc_637a9aca45f01943477f4e17f1fc5b9a";
const originals = [
  { chatId, messageId: "m1", contentHash: hashLocalMessageText("预算只有 10 万") },
  { chatId, messageId: "m2", contentHash: hashLocalMessageText("按每人 8 万招两人，预算够") },
];
describe("proactive opinion to ordinary followup lineage", () => {
  it.each(["sent", "unknown", "missing reply", "missing sources", "partial", "wrong chat", "changed ref", "gap", "too many"])("receipt adapter validates complete sent provenance: %s", async mode => {
    const sentAt = new Date("2026-09-14T11:00:00Z");
    const row = { id: "pd-sent", chat_id: mode === "wrong chat" ? "other" : chatId, reply_message_id: mode === "missing reply" ? null : "opinion",
      sent_at: sentAt, state: mode === "unknown" ? "outcome_unknown" : "sent", source_count: mode === "too many" ? 1001 : mode === "partial" ? 3 : 2 };
    const rows = mode === "missing sources" ? [] : originals.map((binding, source_index) => ({ delivery_id: "pd-sent", source_index: mode === "gap" ? source_index + 1 : source_index,
      kind: "message", ref: mode === "changed ref" ? `message:${"a".repeat(64)}` : createPdSourceRef({ kind: "message", binding }), binding }));
    const provider = createPdReceiptProvider({ queryable: { async query<T>(sql: string) { return { rows: (sql.includes("FROM proactive_discussion_deliveries") ? [row] : rows) as T[] }; } } });
    const result = await provider.listRecentSent({ chatId, after: new Date("2026-09-14T10:00:00Z"), before: new Date("2026-09-14T12:00:00Z"), limit: 2 });
    if (mode === "sent") expect(result).toEqual([{ receiptId: "pd-sent", replyMessageId: "opinion", sentAt, documentSources: [], localMessageSources: originals, sharedChatSources: [], provenanceVersion: 1 }]);
    else expect(result).toEqual([]);
  });
  it("retains every original local binding through two actual provider and draft rewrites", async () => {
    let receipt = { receiptId: "pd-sent", replyMessageId: "opinion", sentAt: new Date("2026-09-14T11:00:00Z"), documentSources: [],
      localMessageSources: originals, sharedChatSources: [], provenanceVersion: 1 as const };
    let body = "预算可能不够，建议先核算总成本";
    const queryable = { async query<T>() { return { rows: [] as T[] }; } };
    const reader = { async listRecentMessages() { return []; }, async readMessagesByIds(input: { messageIds: string[] }) {
      return input.messageIds.includes(receipt.replyMessageId) ? [{ messageId: receipt.replyMessageId, chatId, senderId: "iris", role: "assistant" as const, text: body, sentAt: receipt.sentAt }] : [];
    } };
    const assistantReplies = createAssistantConversationContextProvider({ queryable, reader,
      proactiveReceipts: { async listRecentSent() { return [receipt]; } },
      verifier: { async verify() { return []; } }, localMessageVerifier: { async verify() { return true; } }, requireChatProvenance: true,
    });
    const provider = createFeishuLiveChatContextProvider({ queryable, reader, assistantReplies, now: () => new Date("2026-09-14T12:00:00Z") });
    const orchestrator = createAnswerDraftOrchestrator({ liveChatContextProvider: provider,
      contextBuilder: createDocumentRetrievalContextBuilder({ embeddingProfileId: "test", embedder: { async embedTexts() { return [[1]]; } }, fragments: { async searchSimilarFragments() { return []; } }, canReadDocument: async () => false }),
      planner: { async plan() { return { taskMode: "direct_task", evidenceState: null, premises: [], proposedAnswer: null, missingInformation: [], confidence: null }; } },
      model: { async generateAnswerDraft(input) { return { answerText: input.promptContext.includes(body) ? `改写：${body}` : "没有意见" }; } },
      renderer: { async render() { throw new Error("direct rewrite uses ordinary model"); } },
    });
    for (let iteration = 1; iteration <= 2; iteration++) {
      const result = await orchestrator.generateDraft({ chatId, question: "把上条意见改短一点", liveChatMessages: [], fragmentLimit: 0 });
      expect(result.answerText).toBe(`改写：${body}`);
      expect(result.localMessageSources).toEqual(originals);
      expect(result.sharedChatSources).toBeUndefined();
      body = result.answerText;
      receipt = { ...receipt, receiptId: `passive-${iteration}`, replyMessageId: `rewrite-${iteration}`, localMessageSources: result.localMessageSources! };
    }
  });
});
