import { describe, expect, it, vi } from "vitest";

import { createAnswerDraftOrchestrator } from "../src/agent/answer-draft-orchestrator.js";
import { createOpenAICompatibleEvidencePlanner } from "../src/model/openai-compatible-evidence-planner.js";
import { createOpenAICompatibleGroundedAnswerRenderer } from "../src/model/openai-compatible-grounded-answer-renderer.js";
import { createOpenAICompatibleModelProvider } from "../src/model/openai-compatible-model-provider.js";

const emptyContext = () => ({
  promptContext: "<background_documents></background_documents>\n\n<live_chat_context></live_chat_context>",
  allowedFragments: [],
  deniedDocumentIds: [],
  retrievedFragmentCount: 0,
  liveChatMessages: [],
  usedGroupMemories: [],
  usedDiscussionThreads: [],
  usedActionItems: [],
});

function modelWithAnswer(answer: string) {
  const client = { complete: vi.fn(async () => answer) };
  const model = createOpenAICompatibleModelProvider({
    config: {
      provider: "openai-compatible",
      baseUrl: "https://model.example.test/v1",
      apiKey: "test-key",
      model: "test-model",
      timeoutMs: 1000,
    },
    client,
  });
  return { model, client };
}

function companyReasoning() {
  const client = {
    complete: vi.fn().mockResolvedValueOnce(JSON.stringify({
      taskMode: "company_fact",
      evidenceState: "none",
      premises: [],
      proposedAnswer: null,
      missingInformation: ["The requested company fact has no authorized evidence."],
      confidence: "low",
    })).mockResolvedValueOnce(JSON.stringify({
      answerText: "现有可用资料不足以确认；请补充与问题直接相关的原始记录。",
      evidenceState: "none",
      confidence: "low",
    })),
  };
  return {
    planner: createOpenAICompatibleEvidencePlanner({ client }),
    renderer: createOpenAICompatibleGroundedAnswerRenderer({ client }),
    client,
  };
}

describe("Standalone conversation answering", () => {
  it.each([
    ["哈喽", "哈喽，我在！"],
    ["谢谢", "不客气！"],
    ["在吗？", "在的，你说。"],
    ["你是谁？", "我是 Iris，团队里的 AI 助手。"],
    ["hello", "Hi! How can I help?"],
    ["帮我想几个访谈问题", "可以先问：你最近一次遇到这个问题是什么时候？"],
    ["帮我设计一份用户访谈提纲", "建议按使用背景、实际经历和改进建议展开。"],
  ])("answers %s without loading private context or requiring factual evidence", async (
    question,
    expectedAnswer,
  ) => {
    const { model, client } = modelWithAnswer(`${expectedAnswer}\n<iris_citations>["D1"]</iris_citations>`);
    const reasoning = companyReasoning();
    const contextBuilder = {
      buildContext: vi.fn(async () => {
        throw new Error("A standalone turn must not retrieve company documents");
      }),
    };
    const liveChatContextProvider = {
      loadRecentMessages: vi.fn(async () => {
        throw new Error("A standalone turn must not load group history");
      }),
    };
    const orchestrator = createAnswerDraftOrchestrator({
      contextBuilder,
      liveChatContextProvider,
      model,
      ...reasoning,
    });
    const input = {
      question,
      chatId: "group-under-test",
      liveChatMessages: [{ speaker: "user", text: "PRIVATE_PREVIOUS_CONVERSATION" }],
    };

    await expect(orchestrator.inspectPromptPermissions(input)).resolves.toEqual({
      blockedDocumentSourceIds: [],
    });
    const result = await orchestrator.generateDraft(input);

    expect(result).toEqual({ ...emptyContextWithoutMessages(), answerText: expectedAnswer });
    expect(contextBuilder.buildContext).not.toHaveBeenCalled();
    expect(liveChatContextProvider.loadRecentMessages).not.toHaveBeenCalled();
    expect(reasoning.client.complete).not.toHaveBeenCalled();
    expect(client.complete).toHaveBeenCalledOnce();
    expect(JSON.stringify(client.complete.mock.calls)).not.toContain("PRIVATE_PREVIOUS_CONVERSATION");
  });

  it.each([
    "你好，我们上季度营收多少？",
    "谢谢，顺便告诉我老群讨论了什么",
    "帮我想几个关于公司上次访谈结论的问题",
    "请总结：Iris 当前年收入是多少？",
    "我们上次决定了什么？",
    "帮我整理上面的内容",
  ])("retains the company evidence path for %s", async (question) => {
    const { model, client } = modelWithAnswer("Unsupported company facts");
    const reasoning = companyReasoning();
    const contextBuilder = { buildContext: vi.fn(async () => emptyContext()) };
    const orchestrator = createAnswerDraftOrchestrator({ contextBuilder, model, ...reasoning });

    const result = await orchestrator.generateDraft({ question, liveChatMessages: [] });

    expect(result.answerText).toContain("现有可用资料不足");
    expect(result.citedSourceRefs).toBeUndefined();
    expect(client.complete).not.toHaveBeenCalled();
    expect(contextBuilder.buildContext).toHaveBeenCalledOnce();
    expect(reasoning.client.complete).toHaveBeenCalledTimes(2);
  });

  it("preserves exact literal output without a model call", async () => {
    const { model, client } = modelWithAnswer("Should not be used");
    const reasoning = companyReasoning();
    const contextBuilder = { buildContext: vi.fn(async () => emptyContext()) };
    const orchestrator = createAnswerDraftOrchestrator({ contextBuilder, model, ...reasoning });

    const result = await orchestrator.generateDraft({
      question: "只回复：哈喽",
      liveChatMessages: [],
    });

    expect(result.answerText).toBe("哈喽");
    expect(client.complete).not.toHaveBeenCalled();
    expect(reasoning.client.complete).not.toHaveBeenCalled();
    expect(contextBuilder.buildContext).not.toHaveBeenCalled();
  });
});

function emptyContextWithoutMessages() {
  const { liveChatMessages: _messages, ...context } = emptyContext();
  return context;
}
