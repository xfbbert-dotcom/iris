import { describe, expect, it } from "vitest";
import { createAssistantConversationContextProvider } from "../src/memory/assistant-conversation-context.js";
import { createFeishuLiveChatContextProvider } from "../src/memory/live-chat-context-provider.js";
import { createDocumentRetrievalContextBuilder } from "../src/memory/document-retrieval-context.js";
import { createAnswerDraftOrchestrator } from "../src/agent/answer-draft-orchestrator.js";
import type { Queryable, RetrievedDocumentFragment } from "../src/documents/document-fragment-repository.js";

const fragment: RetrievedDocumentFragment = {
  id: "fragment", documentSourceId: "source", documentSnapshotId: "snapshot", sourceUri: "https://example.com/doc", sourceType: "feishu_wiki",
  chunkIndex: 0, text: "Current authorized original", contentHash: "hash", embedding: [1], embeddingProfileId: "test", createdAt: new Date("2026-09-08T00:00:00Z"),
};
const witness = "旧回复里的文档衍生草稿";

async function run(input: { current?: RetrievedDocumentFragment[]; generic?: boolean; revoked?: boolean; grant?: boolean; fragmentLimit?: number } = {}) {
  const trace = { delivery_id: "delivery", document_source_id: "source", document_snapshot_id: "snapshot",
    cross_group_grant_id: input.grant ? "grant" : null, cross_group_grant_version: input.grant ? 1 : null,
    cross_group_grantor_group_id: input.grant ? "oc-other" : null, cross_group_grantee_group_id: input.grant ? "oc-current" : null };
  const queryable: Queryable = { async query<T>(sql: string) {
    const rows = sql.includes("FROM answer_reply_deliveries") ? [{ delivery_id: "delivery", reply_message_id: "own" }]
      : sql.includes("FROM answer_reply_source_traces") ? input.generic ? [] : [trace] : [];
    return { rows: rows as T[] };
  } };
  const reader = { async listRecentMessages() { return []; }, async readMessagesByIds() {
    return [{ messageId: "own", chatId: "oc-current", senderId: "cli-iris", role: "assistant" as const, text: witness, sentAt: new Date("2026-09-08T11:00:00Z") }];
  } };
  const grants = { async validateExact() { return true; } };
  const assistantReplies = createAssistantConversationContextProvider({ queryable, reader, grants,
    verifier: { async verify() { return [{ documentSourceId: "source", outcome: "allowed" as const }]; } },
  });
  const provider = createFeishuLiveChatContextProvider({ queryable, reader, assistantReplies, now: () => new Date("2026-09-08T12:00:00Z") });
  const contextBuilder = createDocumentRetrievalContextBuilder({ embeddingProfileId: "test", embedder: { async embedTexts(texts) { return texts.map(() => [1]); } },
    fragments: { async searchSimilarFragments() { return input.current ?? [fragment]; } }, canReadDocument: async () => !input.revoked,
    groupId: "oc-current", crossGroupGrantValidator: grants,
  });
  const orchestrator = createAnswerDraftOrchestrator({ liveChatContextProvider: provider, contextBuilder,
    planner: { async plan() { return { taskMode: "direct_task", evidenceState: null, premises: [], proposedAnswer: null, missingInformation: [], confidence: null }; } },
    renderer: { async render() { throw new Error("direct rewrite must use normal model"); } },
    model: { async generateAnswerDraft(request) { return { answerText: request.promptContext.includes(witness) ? "已改写旧回复" : "请补充原始草稿" }; } },
  });
  const messages = await provider.loadRecentMessages({ chatId: "oc-current", question: "把上条草稿改短一点" });
  const result = await orchestrator.generateDraft({ question: "把上条草稿改短一点", chatId: "oc-current", liveChatMessages: [], fragmentLimit: input.fragmentLimit });
  return { messages, result };
}

describe("assistant source lineage through fresh provider, orchestration and prompt assembly", () => {
  it("carries exact lineage and keeps sourced drafts when current fragments cover it", async () => {
    const { messages, result } = await run();
    expect(messages[0]).toMatchObject({ underlyingDocumentSources: [{ documentSourceId: "source", documentSnapshotId: "snapshot" }] });
    expect(result.promptContext).toContain(witness);
    expect(result.answerText).toBe("已改写旧回复");
    expect(result.allowedFragments[0]?.documentSnapshotId).toBe("snapshot");
  });

  it.each([
    { current: [] },
    { current: [{ ...fragment, documentSourceId: "other-source" }] },
    { current: [{ ...fragment, documentSnapshotId: "new-snapshot" }] },
    { fragmentLimit: 0 },
    { revoked: true },
    { grant: true },
    { grant: true, current: [{ ...fragment, sourceType: "feishu_group_document" as const, crossGroupGrantId: "grant", crossGroupGrantVersion: 2, crossGroupGrantorGroupId: "oc-other", crossGroupGranteeGroupId: "oc-current" }] },
  ])("excludes uncovered or changed source lineage before prompt assembly: %j", async input => {
    const { result } = await run(input);
    expect(result.promptContext).not.toContain(witness);
    expect(result.answerText).not.toBe("已改写旧回复");
  });

  it("preserves exact current grant coverage without fabricating document citations", async () => {
    const { result } = await run({ grant: true, current: [{ ...fragment, sourceType: "feishu_group_document", crossGroupGrantId: "grant", crossGroupGrantVersion: 1, crossGroupGrantorGroupId: "oc-other", crossGroupGranteeGroupId: "oc-current" }] });
    expect(result.promptContext).toContain(witness);
    expect(result.allowedFragments[0]?.crossGroupGrantVersion).toBe(1);
    expect(result.citedSourceRefs).toBeUndefined();
  });

  it("retains generic assistant drafts without documents even when retrieval is disabled", async () => {
    const { result } = await run({ generic: true, fragmentLimit: 0 });
    expect(result.promptContext).toContain(witness);
    expect(result.answerText).toBe("已改写旧回复");
  });
});
