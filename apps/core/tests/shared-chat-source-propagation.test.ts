import { describe, expect, it } from "vitest";
import { createAnswerDraftOrchestrator } from "../src/agent/answer-draft-orchestrator.js";
import { createDocumentRetrievalContextBuilder } from "../src/memory/document-retrieval-context.js";
import { selectTopicAwareChatWindow } from "../src/memory/topic-aware-chat-window.js";
import type { LiveChatMessage } from "../src/memory/context-assembly.js";

const binding = { scopeId: "pilot-working-chat", scopeVersion: 1, sourceChatId: "group-a", destinationChatId: "group-b", messageId: "original", contentHash: "a".repeat(64) };
describe("shared source propagation", () => {
  it("retains uncited external labels and inherited assistant sources through model context and result", async () => {
    const labelBinding = { ...binding, messageId: "label", contentHash: "b".repeat(64) };
    const inheritedBinding = { ...binding, messageId: "previous-original", contentHash: "c".repeat(64) };
    const messages: LiveChatMessage[] = [
      { speaker: "author", text: "问卷原始正文", messageId: "original", sourceChatId: "group-a", sourceChatName: "研究群", sourceSentAt: "2026-09-08T08:00:00.000Z", sharedChatSource: binding },
      { speaker: "author", text: "这是问卷", messageId: "label", parentMessageId: "original", sourceChatId: "group-a", sharedChatSource: labelBinding },
      { speaker: "Iris", role: "assistant", text: "上轮问卷草稿", messageId: "reply", sourceChatId: "group-b", underlyingChatSources: [inheritedBinding] },
      { speaker: "Iris", role: "assistant", text: "上轮问卷草稿", messageId: "reply", sourceChatId: "group-b" },
    ];
    let planningSources: string[] = [];
    const orchestrator = createAnswerDraftOrchestrator({ liveChatContextProvider: { async loadRecentMessages() { return messages; } },
      contextBuilder: createDocumentRetrievalContextBuilder({ embeddingProfileId: "test", embedder: { async embedTexts() { return [[1]]; } },
        fragments: { async searchSimilarFragments() { return []; } }, canReadDocument: async () => false }),
      planner: { async plan(input) { planningSources = input.evidence.map(e => e.source); return { taskMode: "direct_task", evidenceState: null, premises: [], proposedAnswer: null, missingInformation: [], confidence: null }; } },
      model: { async generateAnswerDraft(input) { return { answerText: input.promptContext.includes("上轮问卷草稿") ? "改写完成" : "没有草稿" }; } },
      renderer: { async render() { throw new Error("not used"); } },
    });
    const result = await orchestrator.generateDraft({ chatId: "group-b", question: "把问卷草稿改短", liveChatMessages: [], fragmentLimit: 0 });
    expect(result.answerText).toBe("改写完成");
    expect(result.sharedChatSources).toEqual([binding, labelBinding, inheritedBinding]);
    expect(result.promptContext).toContain('source_chat_id="group-a"');
    expect(result.promptContext).toContain("研究群");
    expect(planningSources[0]).toContain("研究群");
    expect(planningSources[0]).toContain("2026-09-08");
    expect(planningSources[1]).toContain("reply_to:C1");
  });

  it("does not bind an implicit same-speaker label to another group's long text", () => {
    const selected = selectTopicAwareChatWindow([
      { speaker: "author", sourceChatId: "group-a", text: "A群长文".repeat(150), messageId: "foreign-original" },
      { speaker: "author", sourceChatId: "group-b", text: "这是问卷", messageId: "label" },
      ...Array.from({ length: 8 }, (_, i) => ({ speaker: "other", sourceChatId: "group-b", text: `收到 ${i}`, messageId: `noise-${i}` })),
    ], "问卷讲什么", 2);
    expect(selected.map(m => m.messageId)).toContain("label");
    expect(selected.map(m => m.messageId)).not.toContain("foreign-original");
  });

  it("does not render an explicit reply relation across source groups", async () => {
    let sources: string[] = [];
    const messages: LiveChatMessage[] = [
      { speaker: "author", text: "问卷原始正文", messageId: "source", sourceChatId: "group-a" },
      { speaker: "author", text: "这是另一份问卷", messageId: "label", parentMessageId: "source", sourceChatId: "group-b" },
    ];
    const orchestrator = createAnswerDraftOrchestrator({ liveChatContextProvider: { async loadRecentMessages() { return messages; } },
      contextBuilder: createDocumentRetrievalContextBuilder({ embeddingProfileId: "test", embedder: { async embedTexts() { return [[1]]; } },
        fragments: { async searchSimilarFragments() { return []; } }, canReadDocument: async () => false }),
      planner: { async plan(input) { sources = input.evidence.map(e => e.source); return { taskMode: "direct_task", evidenceState: null, premises: [], proposedAnswer: null, missingInformation: [], confidence: null }; } },
      model: { async generateAnswerDraft() { return { answerText: "完成" }; } }, renderer: { async render() { throw new Error("not used"); } },
    });
    await orchestrator.generateDraft({ chatId: "group-b", question: "比较问卷", liveChatMessages: [], fragmentLimit: 0 });
    expect(sources[1]).not.toContain("reply_to:C1");
  });
});
