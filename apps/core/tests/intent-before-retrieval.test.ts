import { describe, expect, it, vi } from "vitest";

import {
  createAnswerDraftOrchestrator,
  type GenerateAnswerDraftInput,
} from "../src/agent/answer-draft-orchestrator.js";
import { assemblePromptContext } from "../src/memory/context-assembly.js";
import { createOpenAICompatibleEvidencePlanner } from
  "../src/model/openai-compatible-evidence-planner.js";
import { createOpenAICompatibleGroundedAnswerRenderer } from
  "../src/model/openai-compatible-grounded-answer-renderer.js";
import {
  createAnswerDraftRuntime,
  type AnswerDraftRuntimeDependencies,
} from "../src/runtime/answer-draft-runtime.js";

const directPlan = {
  taskMode: "direct_task" as const,
  evidenceState: null,
  premises: [],
  proposedAnswer: null,
  missingInformation: [],
  confidence: null,
};

function unreachableReasoning() {
  return {
    planner: { plan: vi.fn(async () => { throw new Error("planner must not run"); }) },
    renderer: { render: vi.fn(async () => { throw new Error("renderer must not run"); }) },
  };
}

function contextualRouter() {
  return { classify: vi.fn(async () => "contextual" as const) };
}

describe("intent routing before retrieval", () => {
  it("answers a routed standalone request before any context provider runs", async () => {
    const calls: string[] = [];
    const contextBuilder = {
      buildContext: vi.fn(async () => {
        calls.push("context");
        throw new Error("retrieval must not run");
      }),
    };
    const liveChatContextProvider = {
      loadRecentMessages: vi.fn(async () => {
        calls.push("history");
        throw new Error("history must not run");
      }),
    };
    const requestContextRouter = {
      classify: vi.fn(async () => {
        calls.push("route");
        return "standalone" as const;
      }),
    };
    const model = {
      generateAnswerDraft: vi.fn(async (input: GenerateAnswerDraftInput) => {
        calls.push("model");
        expect(input).toEqual({
          question: "我肚子好饿",
          promptContext:
            "<background_documents></background_documents>\n\n<live_chat_context></live_chat_context>",
          contextMode: "standalone",
        });
        return { answerText: "先吃点东西吧，别饿着。" };
      }),
    };
    const findConflictPlan = vi.fn(async () => {
      throw new Error("conflict lookup must not run");
    });
    const orchestrator = createAnswerDraftOrchestrator({
      contextBuilder,
      liveChatContextProvider,
      requestContextRouter,
      model,
      knowledgeConflictAnswerProvider: { findConflictPlan },
      ...unreachableReasoning(),
    });

    const result = await orchestrator.generateDraft({
      question: " 我肚子好饿 ",
      chatId: "oc_private_history",
      liveChatMessages: [{ speaker: "Alice", text: "DIARY_SENTINEL" }],
    });

    expect(calls).toEqual(["route", "model"]);
    expect(findConflictPlan).not.toHaveBeenCalled();
    expect(result).toEqual({
      answerText: "先吃点东西吧，别饿着。",
      promptContext:
        "<background_documents></background_documents>\n\n<live_chat_context></live_chat_context>",
      allowedFragments: [],
      deniedDocumentIds: [],
      retrievedFragmentCount: 0,
      usedGroupMemories: [],
      usedDiscussionThreads: [],
      usedActionItems: [],
    });
  });

  it("inspects routed standalone permissions without loading context", async () => {
    const calls: string[] = [];
    const orchestrator = createAnswerDraftOrchestrator({
      contextBuilder: {
        buildContext: vi.fn(async () => {
          calls.push("context");
          throw new Error("retrieval must not run");
        }),
      },
      liveChatContextProvider: {
        loadRecentMessages: vi.fn(async () => {
          calls.push("history");
          throw new Error("history must not run");
        }),
      },
      requestContextRouter: {
        classify: vi.fn(async () => {
          calls.push("route");
          return "standalone" as const;
        }),
      },
      model: { generateAnswerDraft: vi.fn() },
      ...unreachableReasoning(),
    });

    await expect(orchestrator.inspectPromptPermissions({
      question: "今天有点累",
      chatId: "oc_private_history",
      liveChatMessages: [],
    })).resolves.toEqual({ blockedDocumentSourceIds: [] });
    expect(calls).toEqual(["route"]);
  });

  it("propagates router failure before context or answer providers run", async () => {
    const routeError = new Error("router unavailable");
    const contextBuilder = { buildContext: vi.fn() };
    const model = { generateAnswerDraft: vi.fn() };
    const planner = { plan: vi.fn() };
    const renderer = { render: vi.fn() };
    const orchestrator = createAnswerDraftOrchestrator({
      contextBuilder,
      requestContextRouter: { classify: vi.fn(async () => { throw routeError; }) },
      model,
      planner,
      renderer,
    });

    await expect(orchestrator.generateDraft({
      question: "今天有点累",
      liveChatMessages: [],
    })).rejects.toBe(routeError);
    expect(contextBuilder.buildContext).not.toHaveBeenCalled();
    expect(model.generateAnswerDraft).not.toHaveBeenCalled();
    expect(planner.plan).not.toHaveBeenCalled();
    expect(renderer.render).not.toHaveBeenCalled();
  });

  it.each(["哈喽", "翻译：hello"]) (
    "keeps the %s shortcut ahead of the semantic router and in standalone provider mode",
    async (question) => {
      const requestContextRouter = { classify: vi.fn() };
      const model = {
        generateAnswerDraft: vi.fn(async (input: GenerateAnswerDraftInput) => {
          expect(input.contextMode).toBe("standalone");
          return { answerText: "自然回答" };
        }),
      };
      const orchestrator = createAnswerDraftOrchestrator({
        contextBuilder: { buildContext: vi.fn() },
        requestContextRouter,
        model,
        ...unreachableReasoning(),
      });

      await expect(orchestrator.generateDraft({ question, liveChatMessages: [] }))
        .resolves.toMatchObject({ answerText: "自然回答", allowedFragments: [] });
      expect(requestContextRouter.classify).not.toHaveBeenCalled();
    },
  );

  it("preserves both originals through contextual comparison planning and rendering", async () => {
    const oldOriginal = "旧问卷原文：关注满意度和价格。";
    const newOriginal = "新问卷原文：关注使用场景和回访意愿。";
    const plannerInputs: unknown[] = [];
    const rendererInputs: unknown[] = [];
    const planner = createOpenAICompatibleEvidencePlanner({
      client: {
        async complete(messages) {
          plannerInputs.push(JSON.parse(messages[1]!.content));
          return JSON.stringify({
            taskMode: "company_fact",
            evidenceState: "complete_inference",
            premises: [
              { citationRef: "C1", statement: "旧版关注满意度和价格。" },
              { citationRef: "C2", statement: "新版关注场景和回访意愿。" },
            ],
            proposedAnswer: "新版增加场景和回访意愿。",
            missingInformation: [],
            confidence: "high",
          });
        },
      },
    });
    const renderer = createOpenAICompatibleGroundedAnswerRenderer({
      client: {
        async complete(messages) {
          rendererInputs.push(JSON.parse(messages[1]!.content));
          return JSON.stringify({
            answerText: "新版更重视具体场景和后续回访。",
            evidenceState: "complete_inference",
            confidence: "high",
          });
        },
      },
    });
    const contextBuilder = {
      buildContext: vi.fn(async (input: { liveChatMessages: Array<{ speaker: string; text: string }> }) => ({
        promptContext: assemblePromptContext({
          backgroundDocuments: [],
          liveChatMessages: input.liveChatMessages,
        }),
        liveChatMessages: input.liveChatMessages,
        allowedFragments: [],
        deniedDocumentIds: [],
        retrievedFragmentCount: 0,
        usedGroupMemories: [],
        usedDiscussionThreads: [],
        usedActionItems: [],
      })),
    };
    const orchestrator = createAnswerDraftOrchestrator({
      contextBuilder,
      requestContextRouter: contextualRouter(),
      model: { generateAnswerDraft: vi.fn() },
      planner,
      renderer,
    });

    const result = await orchestrator.generateDraft({
      question: "新问卷和旧问卷有什么区别？",
      liveChatMessages: [
        { speaker: "Alice", text: oldOriginal },
        { speaker: "Alice", text: newOriginal },
      ],
    });

    expect(JSON.stringify(plannerInputs)).toContain(oldOriginal);
    expect(JSON.stringify(plannerInputs)).toContain(newOriginal);
    expect(JSON.stringify(rendererInputs)).toContain(oldOriginal);
    expect(JSON.stringify(rendererInputs)).toContain(newOriginal);
    expect(result.answerText).toBe("新版更重视具体场景和后续回访。");
  });

  it("keeps authorized contextual material and citations for a semantic direct task", async () => {
    const fragment = {
      id: "fragment-1",
      documentSnapshotId: "snapshot-1",
      documentSourceId: "source-1",
      chunkIndex: 0,
      text: "活动名称是秋日访谈会。",
      embedding: [1, 0],
      embeddingProfileId: "profile-1",
      contentHash: "content-hash-1",
      createdAt: new Date("2026-09-08T00:00:00.000Z"),
      sourceUri: "https://docs.example.test/source-1",
      sourceType: "feishu_group_document" as const,
      sourceTitle: "活动方案",
      indexedAt: new Date("2026-09-08T00:00:00.000Z"),
    };
    const promptContext = assemblePromptContext({
      backgroundDocuments: [{ source: fragment.sourceUri, text: fragment.text }],
      liveChatMessages: [{ speaker: "Iris", role: "assistant", text: "欢迎参加秋日访谈会，期待见到你。" }],
    });
    const model = {
      generateAnswerDraft: vi.fn(async (input: GenerateAnswerDraftInput) => {
        expect(input.contextMode).toBeUndefined();
        expect(input.promptContext).toContain("秋日访谈会");
        return { answerText: "秋日访谈会，等你来！", citedSourceRefs: ["D1"] };
      }),
    };
    const orchestrator = createAnswerDraftOrchestrator({
      contextBuilder: {
        buildContext: vi.fn(async () => ({
          promptContext,
          liveChatMessages: [
            { speaker: "Iris", role: "assistant" as const, text: "欢迎参加秋日访谈会，期待见到你。" },
          ],
          allowedFragments: [fragment],
          deniedDocumentIds: [],
          retrievedFragmentCount: 1,
          usedGroupMemories: [],
          usedDiscussionThreads: [],
          usedActionItems: [],
        })),
      },
      requestContextRouter: contextualRouter(),
      model,
      planner: { plan: vi.fn(async () => directPlan) },
      renderer: { render: vi.fn() },
    });

    const result = await orchestrator.generateDraft({
      question: "再亲切一点，保留活动名称",
      liveChatMessages: [],
    });

    expect(result.citedSourceRefs).toEqual(["D1"]);
    expect(result.allowedFragments).toEqual([fragment]);
  });

  it("keeps a revoked contextual source blocked before planner or model execution", async () => {
    const model = { generateAnswerDraft: vi.fn() };
    const planner = { plan: vi.fn() };
    const orchestrator = createAnswerDraftOrchestrator({
      contextBuilder: {
        buildContext: vi.fn(async () => ({
          promptContext: "AUTHORIZED_TEXT_WAS_REVOKED",
          liveChatMessages: [],
          allowedFragments: [],
          deniedDocumentIds: ["source-revoked"],
          retrievedFragmentCount: 1,
          usedGroupMemories: [],
          usedDiscussionThreads: [],
          usedActionItems: [],
        })),
      },
      requestContextRouter: contextualRouter(),
      model,
      planner,
      renderer: { render: vi.fn() },
    });

    const result = await orchestrator.generateDraft({
      question: "把上一条改短一点",
      liveChatMessages: [],
    });

    expect(result.answerText).toBe("Answer withheld by the live permission guard.");
    expect(result.deniedDocumentIds).toEqual(["source-revoked"]);
    expect(planner.plan).not.toHaveBeenCalled();
    expect(model.generateAnswerDraft).not.toHaveBeenCalled();
  });

  it("uses the production runtime router before lazy retrieval", async () => {
    const transportCalls: unknown[][] = [];
    const client = {
      complete: vi.fn(async (...args: unknown[]) => {
        transportCalls.push(args);
        return transportCalls.length === 1
          ? JSON.stringify({ route: "standalone" })
          : "去吃点东西吧，别饿着。";
      }),
    };
    const searchSimilarFragments = vi.fn(async () => []);
    const loadRecentMessages = vi.fn(async () => []);
    const getStaticDevelopmentProfile = vi.fn(async () => ({
      id: "static-dev-6d",
      provider: "static-dev" as const,
      model: "static-dev-6d",
      dimensions: 6,
      displayName: "Static development",
      status: "active" as const,
      createdAt: new Date("2026-09-08T00:00:00.000Z"),
    }));
    const dependencies: AnswerDraftRuntimeDependencies = {
      createPostgresPool: () => ({ query: vi.fn(), end: vi.fn(async () => undefined) }),
      createDocumentFragmentRepository: () => ({ searchSimilarFragments }),
      createConversationMessageRepository: () => ({ listRecentByChat: vi.fn(async () => []) }),
      createLiveChatContextProvider: () => ({ loadRecentMessages }),
      createChatCompletionsClient: () => client,
      createEmbeddingProfileRepository: () => ({
        getStaticDevelopmentProfile,
        findOrCreateProfile: vi.fn(),
        getProfileById: vi.fn(),
      }),
    };
    const runtime = createAnswerDraftRuntime({
      env: {
        IRIS_ENABLE_INTERNAL_ANSWER_DRAFTS: "true",
        IRIS_INTERNAL_DRAFT_PERMISSION_MODE: "allow-indexed",
        DATABASE_URL: "postgres://test.invalid/iris",
        IRIS_MODEL_PROVIDER: "openai-compatible",
        IRIS_MODEL_BASE_URL: "https://model.invalid/v1",
        IRIS_MODEL_API_KEY: "test-key",
        IRIS_MODEL_NAME: "test-model",
      },
      dependencies,
    });

    const result = await runtime!.answerDraftOrchestrator.generateDraft({
      question: "我肚子好饿",
      chatId: "oc_no_retrieval",
      liveChatMessages: [{ speaker: "Alice", text: "PRIVATE_DIARY_SENTINEL" }],
    });

    expect(transportCalls).toHaveLength(2);
    expect(JSON.stringify(transportCalls[0])).toContain('"route"');
    expect(JSON.stringify(transportCalls[1])).not.toContain("PRIVATE_DIARY_SENTINEL");
    expect(result).toMatchObject({
      answerText: "去吃点东西吧，别饿着。",
      allowedFragments: [],
      deniedDocumentIds: [],
      retrievedFragmentCount: 0,
    });
    expect(result.citedSourceRefs).toBeUndefined();
    expect(loadRecentMessages).not.toHaveBeenCalled();
    expect(searchSimilarFragments).not.toHaveBeenCalled();
    expect(getStaticDevelopmentProfile).not.toHaveBeenCalled();

    await runtime!.close();
  });
});
