import { describe, expect, it } from "vitest";
import { createAnswerDraftRuntime } from "../src/runtime/answer-draft-runtime.js";
import type { WorkingChatScope, WorkingChatScopeRepository } from "../src/shared-chat/working-chat-scope.js";
import type { FeishuChatHistoryMessage } from "../src/feishu/feishu-chat-history-reader.js";
import { createDirectTaskReasoningDoubles } from "./answer-reasoning-test-doubles.js";

describe("production shared working-chat wiring", () => {
  it("uses ordinary external chat in the real runtime without any Wiki source", async () => {
    const fixture = makeRuntime();
    try {
      const answer = await fixture.runtime.answerDraftOrchestrator.generateDraft({
        chatId: "group-b", question: "其他群最近聊了什么？", liveChatMessages: [],
      });
      expect(answer.promptContext).toContain("普通工作讨论，未发布知识库");
      expect(answer.sharedChatSources).toEqual([expect.objectContaining({
        scopeId: "pilot-working-chat", scopeVersion: 1, sourceChatId: "group-a",
        destinationChatId: "group-b", messageId: "source-a",
      })]);
      expect(answer.allowedFragments).toEqual([]);
      expect(fixture.runtime.workingChatScopes).toBeDefined();
    } finally { await fixture.runtime.close(); }
  });

  it.each(["scope", "runtime", "bot"] as const)("omits external content when %s is unavailable", async blocked => {
    const fixture = makeRuntime(blocked);
    try {
      const answer = await fixture.runtime.answerDraftOrchestrator.generateDraft({
        chatId: "group-b", question: "其他群最近聊了什么？", liveChatMessages: [],
      });
      expect(answer.promptContext).not.toContain("普通工作讨论，未发布知识库");
      expect(answer.sharedChatSources ?? []).toEqual([]);
    } finally { await fixture.runtime.close(); }
  });

  it("does not look up scope or bot history for a standalone remark", async () => {
    const fixture = makeRuntime(undefined, "standalone");
    try {
      const answer = await fixture.runtime.answerDraftOrchestrator.generateDraft({
        chatId: "group-b", question: "我肚子好饿", liveChatMessages: [],
      });
      expect(fixture.reads).toEqual([]);
      expect(answer.promptContext).not.toContain("普通工作讨论");
      expect(answer.allowedFragments).toEqual([]);
    } finally { await fixture.runtime.close(); }
  });
});

function makeRuntime(blocked?: "scope" | "runtime" | "bot", route: "standalone" | "contextual" = "contextual") {
  const reads: string[] = [];
  const now = new Date();
  const scope: WorkingChatScope = { id: "pilot-working-chat", version: 1, state: "active",
    groups: [{ chatId: "group-a", name: "工作组 A" }, { chatId: "group-b", name: "工作组 B" }],
    updatedAt: now, updatedBy: "operator" };
  const scopes: WorkingChatScopeRepository = {
    async get() { return blocked === "scope" ? undefined : scope; },
    async replace() { throw new Error("must not mutate scope while answering"); },
    async resolveForChat() { reads.push("scope"); return blocked === "scope" ? undefined : scope; },
    async validateExact() { return blocked !== "scope"; },
  };
  const original: FeishuChatHistoryMessage = { chatId: "group-a", messageId: "source-a",
    senderId: "alice", text: "普通工作讨论，未发布知识库", sentAt: new Date(now.getTime() - 60000) };
  const query = async () => ({ rows: [] });
  const pool = { query, async connect() { return { query, release() {} }; }, async end() {} };
  const { planner, renderer } = createDirectTaskReasoningDoubles();
  const runtime = createAnswerDraftRuntime({
    env: { IRIS_ENABLE_INTERNAL_ANSWER_DRAFTS: "true", IRIS_INTERNAL_DRAFT_PERMISSION_MODE: "source-policy",
      DATABASE_URL: "postgres://unused:test@localhost/unused", IRIS_MODEL_PROVIDER: "openai-compatible",
      IRIS_MODEL_BASE_URL: "https://model.invalid/v1", IRIS_MODEL_API_KEY: "test", IRIS_MODEL_NAME: "test",
      FEISHU_APP_ID: "app-test", FEISHU_APP_SECRET: "secret-test" },
    runtimeController: {
      canReadDocuments: () => false, canRetrieveKnowledgeBase: () => false,
      canReadGroupContext: chatId => blocked !== "runtime" || chatId !== "group-a",
      canProcessGroupMessage: () => true, canReplyWhenMentioned: () => true,
    },
    dependencies: {
      createPostgresPool: () => pool,
      createWorkingChatScopeRepository: () => scopes,
      createFeishuBotChatAccessChecker: () => ({ async canAccessChat({ chatId }) {
        reads.push(`bot:${chatId}`); return blocked !== "bot" || chatId !== "group-a";
      } }),
      createFeishuTenantAccessTokenProvider: () => ({ async getTenantAccessToken() { return "test"; } }),
      createFeishuDocumentPermissionChecker: () => ({ async canReadSource() { return false; } }),
      createFeishuChatHistoryReader: () => ({
        async listRecentMessages({ chatId }) { reads.push(`history:${chatId}`); return chatId === "group-a" ? [original] : []; },
        async readMessagesByIds({ chatId, messageIds }) {
          reads.push(`exact:${chatId}`); return chatId === "group-a" && messageIds.includes(original.messageId) ? [original] : [];
        },
      }),
      createDocumentFragmentRepository: () => ({ async searchSimilarFragments() { return []; } }),
      createDocumentSourceRegistry: () => ({ async findSourceById() { return undefined; } }),
      createModelProvider: () => ({ async generateAnswerDraft() { return { answerText: "测试回答" }; } }),
      createRequestContextRouter: () => ({ async classify() { return route; } }),
      createEvidencePlanner: () => planner, createGroundedAnswerRenderer: () => renderer,
      createEmbeddingProfileRepository: () => ({
        async getStaticDevelopmentProfile() { return { id: "static-dev-6d", provider: "static-dev", model: "static-dev-6d",
          dimensions: 6, displayName: "static", status: "active", createdAt: now }; },
        async findOrCreateProfile() { throw new Error("no embedding writes"); }, async getProfileById() { throw new Error("no profile lookup needed"); },
      }),
    },
  });
  if (!runtime) throw new Error("runtime fixture must be enabled");
  return { runtime, reads };
}
