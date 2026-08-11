import { describe, expect, it, vi } from "vitest";

import {
  createAnswerDraftOrchestrator as createProductionAnswerDraftOrchestrator,
  type ModelProvider,
} from "../src/agent/answer-draft-orchestrator.js";
import type { AgentExecutionObserver } from "../src/agent-runtime/agent-execution-observer.js";
import type { EvidencePlanner } from "../src/model/openai-compatible-evidence-planner.js";
import type { GroundedAnswerRenderer } from "../src/model/openai-compatible-grounded-answer-renderer.js";
import {
  createCompanyFactReasoningDoubles,
  createDirectTaskReasoningDoubles,
} from "./answer-reasoning-test-doubles.js";

type OrchestratorDependencies = Parameters<typeof createProductionAnswerDraftOrchestrator>[0];

const DIRECT_SUMMARY_QUESTION = "Please summarize this text: The launch moved to Friday.";
const COMPANY_CONTEXT_QUESTION = "What company context supports the launch schedule?";

function createAnswerDraftOrchestrator(
  input: Omit<OrchestratorDependencies, "planner" | "renderer"> &
    Partial<Pick<OrchestratorDependencies, "planner" | "renderer">>,
) {
  return createProductionAnswerDraftOrchestrator({
    ...createCompanyFactReasoningDoubles(),
    ...input,
  });
}

describe("AnswerDraftOrchestrator", () => {
  it("keeps a direct task isolated from retrieved company context", async () => {
    const contextBuilder = {
      buildContext: vi.fn(async () => {
        throw new Error("direct tasks must not build company context");
      }),
    };
    const model: ModelProvider = {
      generateAnswerDraft: vi.fn(async () => ({
        answerText: "  Draft answer.  ",
        citedSourceRefs: ["D1"],
      })),
    };
    const orchestrator = createAnswerDraftOrchestrator({ contextBuilder, model });

    const result = await orchestrator.generateDraft({
      question: DIRECT_SUMMARY_QUESTION,
      liveChatMessages: [{ speaker: "Alice", text: "Please answer." }],
      fragmentLimit: 4,
      liveChatLimit: 10,
    });

    expect(contextBuilder.buildContext).not.toHaveBeenCalled();
    expect(model.generateAnswerDraft).toHaveBeenCalledWith({
      question: DIRECT_SUMMARY_QUESTION,
      promptContext:
        "<background_documents></background_documents>\n\n<live_chat_context></live_chat_context>",
    });
    expect(result).toEqual({
      answerText: "Draft answer.",
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

  it("ignores model-proposed document citations on direct tasks", async () => {
    const contextBuilder = {
      buildContext: vi.fn(async () => ({
        promptContext:
          "<background_documents></background_documents>\n\n<live_chat_context></live_chat_context>",
        allowedFragments: [],
        deniedDocumentIds: [],
        retrievedFragmentCount: 0,
        usedGroupMemories: [],
      })),
    };
    const model: ModelProvider = {
      generateAnswerDraft: vi.fn(async () => ({
        answerText: "Draft answer.",
        citedSourceRefs: ["D1"],
      })),
    };
    const orchestrator = createAnswerDraftOrchestrator({ contextBuilder, model });

    const result = await orchestrator.generateDraft({
      question: DIRECT_SUMMARY_QUESTION,
      liveChatMessages: [],
    });

    expect(result.answerText).toBe("Draft answer.");
    expect(result.citedSourceRefs).toBeUndefined();
  });

  it("skips the model when a prompt-ranked source failed the live permission check", async () => {
    const contextBuilder = {
      buildContext: vi.fn(async () => ({
        promptContext:
          "<background_documents></background_documents>\n\n<live_chat_context></live_chat_context>",
        allowedFragments: [],
        deniedDocumentIds: ["source-denied"],
        retrievedFragmentCount: 1,
        usedGroupMemories: [],
      })),
    };
    const model: ModelProvider = {
      generateAnswerDraft: vi.fn(async () => ({ answerText: "Must not be generated." })),
    };
    const reasoning = createDirectTaskReasoningDoubles();
    const orchestrator = createAnswerDraftOrchestrator({
      contextBuilder,
      model,
      ...reasoning,
    });

    const result = await orchestrator.generateDraft({
      question: "What is Iris's current annual revenue?",
      liveChatMessages: [],
    });

    expect(model.generateAnswerDraft).not.toHaveBeenCalled();
    expect(reasoning.planner.plan).not.toHaveBeenCalled();
    expect(reasoning.renderer.render).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      answerText: "Answer withheld by the live permission guard.",
      deniedDocumentIds: ["source-denied"],
    });
  });

  it("rechecks prompt permissions without calling the model provider", async () => {
    const contextBuilder = {
      buildContext: vi.fn(async () => ({
        promptContext:
          "<background_documents></background_documents>\n\n<live_chat_context></live_chat_context>",
        allowedFragments: [],
        deniedDocumentIds: ["source-denied"],
        retrievedFragmentCount: 1,
        usedGroupMemories: [],
      })),
    };
    const model: ModelProvider = {
      generateAnswerDraft: vi.fn(async () => ({ answerText: "Must not be generated." })),
    };
    const orchestrator = createAnswerDraftOrchestrator({ contextBuilder, model }) as ReturnType<
      typeof createAnswerDraftOrchestrator
    > & {
      inspectPromptPermissions(input: {
        question: string;
        liveChatMessages: [];
      }): Promise<{ blockedDocumentSourceIds: string[] }>;
    };

    const result = await orchestrator.inspectPromptPermissions({
      question: "What is Iris's current annual revenue?",
      liveChatMessages: [],
    });

    expect(result).toEqual({ blockedDocumentSourceIds: ["source-denied"] });
    expect(contextBuilder.buildContext).toHaveBeenCalledTimes(1);
    expect(model.generateAnswerDraft).not.toHaveBeenCalled();
  });

  it("skips permission context inspection for a direct task", async () => {
    const contextBuilder = {
      buildContext: vi.fn(async () => {
        throw new Error("direct tasks must not inspect company context");
      }),
    };
    const model: ModelProvider = {
      generateAnswerDraft: vi.fn(async () => ({ answerText: "Must not be generated." })),
    };
    const orchestrator = createAnswerDraftOrchestrator({ contextBuilder, model });

    await expect(orchestrator.inspectPromptPermissions({
      question: DIRECT_SUMMARY_QUESTION,
      liveChatMessages: [],
    })).resolves.toEqual({ blockedDocumentSourceIds: [] });

    expect(contextBuilder.buildContext).not.toHaveBeenCalled();
    expect(model.generateAnswerDraft).not.toHaveBeenCalled();
  });

  it("rejects blank questions before building context", async () => {
    const contextBuilder = { buildContext: vi.fn() };
    const model = { generateAnswerDraft: vi.fn() };
    const orchestrator = createAnswerDraftOrchestrator({ contextBuilder, model });

    await expect(
      orchestrator.generateDraft({ question: "   ", liveChatMessages: [] }),
    ).rejects.toThrow("question must not be blank");
    expect(contextBuilder.buildContext).not.toHaveBeenCalled();
    expect(model.generateAnswerDraft).not.toHaveBeenCalled();
  });

  it("rejects oversized questions before building context", async () => {
    const contextBuilder = { buildContext: vi.fn() };
    const model = { generateAnswerDraft: vi.fn() };
    const orchestrator = createAnswerDraftOrchestrator({ contextBuilder, model });

    await expect(
      orchestrator.generateDraft({
        question: `${"Q".repeat(4001)} trailing question detail`,
        liveChatMessages: [],
      }),
    ).rejects.toThrow("question must be at most 4000 characters");
    expect(contextBuilder.buildContext).not.toHaveBeenCalled();
    expect(model.generateAnswerDraft).not.toHaveBeenCalled();
  });

  it("loads stored live chat context when chatId is supplied", async () => {
    const contextBuilder = {
      buildContext: vi.fn(async () => ({
        promptContext:
          "<background_documents></background_documents>\n\n<live_chat_context></live_chat_context>",
        allowedFragments: [],
        deniedDocumentIds: [],
        retrievedFragmentCount: 0,
        usedGroupMemories: [],
      })),
    };
    const model: ModelProvider = {
      generateAnswerDraft: vi.fn(async () => ({ answerText: "Draft answer." })),
    };
    const liveChatContextProvider = {
      loadRecentMessages: vi.fn(async () => [
        { speaker: "ou_a", text: "Stored context" },
      ]),
    };
    const orchestrator = createAnswerDraftOrchestrator({
      contextBuilder,
      model,
      liveChatContextProvider,
    });

    await orchestrator.generateDraft({
      question: COMPANY_CONTEXT_QUESTION,
      chatId: "oc_1",
      liveChatMessages: [{ speaker: "ou_b", text: "Current question context" }],
      liveChatLimit: 8,
    });

    expect(liveChatContextProvider.loadRecentMessages).toHaveBeenCalledWith({
      chatId: "oc_1",
      limit: 8,
    });
    expect(contextBuilder.buildContext).toHaveBeenCalledWith({
      queryText: COMPANY_CONTEXT_QUESTION,
      supplementalQueryText: expect.stringContaining("Recent live chat:"),
      liveChatMessages: [
        { speaker: "ou_a", text: "Stored context" },
        { speaker: "ou_b", text: "Current question context" },
      ],
      fragmentLimit: undefined,
      liveChatLimit: 8,
    });
  });

  it("keeps the current question clean and sends recent chat as a supplemental query", async () => {
    const contextBuilder = {
      buildContext: vi.fn(async (_input: {
        queryText: string;
        supplementalQueryText?: string;
      }) => ({
        promptContext:
          "<background_documents></background_documents>\n\n<live_chat_context></live_chat_context>",
        allowedFragments: [],
        deniedDocumentIds: [],
        retrievedFragmentCount: 0,
        usedGroupMemories: [],
      })),
    };
    const model: ModelProvider = {
      generateAnswerDraft: vi.fn(async () => ({ answerText: "Draft answer." })),
    };
    const orchestrator = createAnswerDraftOrchestrator({ contextBuilder, model });

    const question = "Quello 的电子宠物为什么会自己产生目标？";
    await orchestrator.generateDraft({
      question,
      liveChatMessages: [
        { speaker: "Alice", text: "我希望它可以自己推理" },
        { speaker: "Alice", text: question },
      ],
    });

    const input = contextBuilder.buildContext.mock.calls[0]?.[0];
    expect(input?.queryText).toBe(question);
    expect(input?.supplementalQueryText).toContain("Alice: 我希望它可以自己推理");
    const supplementalQueryText = String(input?.supplementalQueryText);
    expect(supplementalQueryText.match(/Quello 的电子宠物为什么会自己产生目标？/gu))
      .toHaveLength(1);
    expect(supplementalQueryText.length).toBeLessThanOrEqual(4000);
  });

  it("renders a partial company answer from only planner-selected evidence", async () => {
    const contextBuilder = {
      buildContext: vi.fn(async () => ({
        promptContext: "<background_documents></background_documents>",
        allowedFragments: [
          retrievedFragment("quello-overview", "Overview", 0),
          retrievedFragment("quello-evolution", "Evolution", 3),
        ],
        deniedDocumentIds: [],
        retrievedFragmentCount: 10,
        liveChatMessages: [{ speaker: "Alice", text: "请基于资料推理" }],
        usedGroupMemories: [],
        usedDiscussionThreads: [],
        usedActionItems: [],
      })),
    };
    const model: ModelProvider = {
      generateAnswerDraft: vi.fn(async () => ({ answerText: "Legacy answer" })),
    };
    const planner: EvidencePlanner = {
      plan: vi.fn<EvidencePlanner["plan"]>(async () => ({
        taskMode: "company_fact",
        evidenceState: "partial",
        premises: [{ citationRef: "D2", statement: "Experience shapes preferences" }],
        proposedAnswer: "Goals likely emerge from state and experience",
        missingInformation: ["The exact selection algorithm"],
        confidence: "medium",
      })),
    };
    const renderer: GroundedAnswerRenderer = {
      render: vi.fn<GroundedAnswerRenderer["render"]>(async () => ({
        answerText: "证据不足；基于现有证据，我的推测是目标会从状态和经验中形成。",
        evidenceState: "partial",
        confidence: "medium",
      })),
    };
    const orchestrator = createAnswerDraftOrchestrator({
      contextBuilder,
      model,
      planner,
      renderer,
    } as Parameters<typeof createAnswerDraftOrchestrator>[0] & {
      planner: EvidencePlanner;
      renderer: GroundedAnswerRenderer;
    });

    const result = await orchestrator.generateDraft({
      question: "Quello 如何产生目标？",
      liveChatMessages: [],
    });

    expect(result.answerText).toContain("基于现有证据，我的推测是");
    expect(result.citedSourceRefs).toEqual(["D2"]);
    expect(model.generateAnswerDraft).not.toHaveBeenCalled();
    expect(renderer.render).toHaveBeenCalledWith(expect.objectContaining({
      evidence: [{
        citationRef: "D2",
        source: "https://example.com/quello-evolution#chunk-3",
        text: "Evolution",
      }],
    }));
  });

  it.each([
    "请整理以下文本：会议决定周五上线。",
    "Please translate: What changed?",
  ])("keeps an explicit non-company task on the direct answer path: %s", async (question) => {
    const contextBuilder = {
      buildContext: vi.fn(async () => ({
        promptContext: "<background_documents>SECRET_COMPANY_CONTEXT</background_documents>",
        allowedFragments: [],
        deniedDocumentIds: [],
        retrievedFragmentCount: 0,
        liveChatMessages: [],
        usedGroupMemories: [],
        usedDiscussionThreads: [],
        usedActionItems: [],
      })),
    };
    const model: ModelProvider = {
      generateAnswerDraft: vi.fn(async () => ({ answerText: "整理后的会议纪要。" })),
    };
    const planner: EvidencePlanner = {
      plan: vi.fn(async () => {
        throw new Error("planner must not run for an explicit direct task");
      }),
    };
    const renderer: GroundedAnswerRenderer = {
      render: vi.fn(async () => {
        throw new Error("renderer must not run for a direct task");
      }),
    };
    const orchestrator = createAnswerDraftOrchestrator({
      contextBuilder,
      model,
      planner,
      renderer,
    });

    const result = await orchestrator.generateDraft({
      question,
      liveChatMessages: [],
    });

    expect(result).toEqual(expect.objectContaining({
      answerText: "整理后的会议纪要。",
      promptContext:
        "<background_documents></background_documents>\n\n<live_chat_context></live_chat_context>",
      allowedFragments: [],
      deniedDocumentIds: [],
      retrievedFragmentCount: 0,
      usedGroupMemories: [],
      usedDiscussionThreads: [],
      usedActionItems: [],
    }));
    expect(contextBuilder.buildContext).not.toHaveBeenCalled();
    expect(model.generateAnswerDraft).toHaveBeenCalledWith(expect.objectContaining({
      promptContext:
        "<background_documents></background_documents>\n\n<live_chat_context></live_chat_context>",
    }));
    expect(planner.plan).not.toHaveBeenCalled();
    expect(renderer.render).not.toHaveBeenCalled();
  });

  it.each([
    ["只回复：IRIS_REAL_OK", "IRIS_REAL_OK"],
    [
      "Please output only: What is Iris's current annual revenue?",
      "What is Iris's current annual revenue?",
    ],
  ])("returns an exact-output payload literally without context or a model: %s", async (
    question,
    expectedAnswer,
  ) => {
    const contextBuilder = { buildContext: vi.fn() };
    const model: ModelProvider = { generateAnswerDraft: vi.fn() };
    const reasoning = createDirectTaskReasoningDoubles();
    const orchestrator = createAnswerDraftOrchestrator({
      contextBuilder,
      model,
      ...reasoning,
    });

    await expect(orchestrator.generateDraft({
      question,
      liveChatMessages: [],
    })).resolves.toEqual(expect.objectContaining({
      answerText: expectedAnswer,
      allowedFragments: [],
      deniedDocumentIds: [],
    }));

    expect(contextBuilder.buildContext).not.toHaveBeenCalled();
    expect(model.generateAnswerDraft).not.toHaveBeenCalled();
    expect(reasoning.planner.plan).not.toHaveBeenCalled();
    expect(reasoning.renderer.render).not.toHaveBeenCalled();
  });

  it("does not let a planner direct-task result bypass company-fact evidence controls", async () => {
    const model: ModelProvider = {
      generateAnswerDraft: vi.fn(async () => ({ answerText: "Unbounded company answer" })),
    };
    const planner: EvidencePlanner = {
      plan: vi.fn<EvidencePlanner["plan"]>(async () => ({
        taskMode: "direct_task",
        evidenceState: null,
        premises: [],
        proposedAnswer: null,
        missingInformation: [],
        confidence: null,
      })),
    };
    const renderer: GroundedAnswerRenderer = {
      render: vi.fn(async () => {
        throw new Error("renderer must not run for an invalid plan");
      }),
    };
    const orchestrator = createAnswerDraftOrchestrator({
      contextBuilder: {
        buildContext: vi.fn(async () => ({
          promptContext: "<background_documents></background_documents>",
          allowedFragments: [],
          deniedDocumentIds: [],
          retrievedFragmentCount: 0,
          liveChatMessages: [],
          usedGroupMemories: [],
          usedDiscussionThreads: [],
          usedActionItems: [],
        })),
      },
      model,
      planner,
      renderer,
    });

    for (const question of [
      "What is Iris's current annual revenue?",
      "总结 Iris 当前年收入",
      "列出这个季度的营收",
      "请总结：Iris 当前年收入是多少？",
      "列出这个季度的营收：",
      "Please list: Iris Q2 customers",
      "Please summarize: Iris current annual revenue",
      "Please output only the answer: What is Iris's current annual revenue?",
      "Please format the answer as JSON: Who are Iris Q2 customers?",
      "Please summarize the previous message: briefly",
    ]) {
      await expect(orchestrator.generateDraft({
        question,
        liveChatMessages: [],
      })).rejects.toThrow("company-fact evidence planner returned an invalid task mode");
    }
    expect(model.generateAnswerDraft).not.toHaveBeenCalled();
    expect(renderer.render).not.toHaveBeenCalled();
  });

  it("plans company facts from bounded group-local evidence without citing non-documents", async () => {
    const question = "Quello 的目标由什么产生？";
    const contextBuilder = {
      buildContext: vi.fn(async () => ({
        promptContext: "<bounded_context />",
        allowedFragments: [retrievedFragment("document-source", "Document premise", 0)],
        deniedDocumentIds: [],
        retrievedFragmentCount: 1,
        liveChatMessages: [
          { speaker: "Alice", text: "目标会随体验积累而变化。" },
          { speaker: "Bob", text: question },
        ],
        usedGroupMemories: [{
          id: "memory-1",
          scope: "group" as const,
          category: "project" as const,
          content: "偏好会形成长期记忆。",
          evidenceMessageIds: ["message-memory"],
        }],
        usedDiscussionThreads: [{
          id: "thread-1",
          status: "open" as const,
          summary: "团队正在讨论目标形成机制。",
          evidenceMessageIds: ["message-thread"],
        }],
        usedActionItems: [{
          id: "action-1",
          status: "open" as const,
          description: "验证目标形成规则。",
          ownerRef: "Alice",
          evidenceMessageIds: ["message-action"],
        }],
      })),
    };
    const planner: EvidencePlanner = {
      plan: vi.fn<EvidencePlanner["plan"]>(async () => ({
        taskMode: "company_fact",
        evidenceState: "complete_inference",
        premises: [
          { citationRef: "C1", statement: "Chat premise" },
          { citationRef: "M1", statement: "Memory premise" },
          { citationRef: "T1", statement: "Thread premise" },
          { citationRef: "D1", statement: "Document premise" },
          { citationRef: "A1", statement: "Action premise" },
        ],
        proposedAnswer: "Goals emerge from bounded group evidence.",
        missingInformation: [],
        confidence: "medium",
      })),
    };
    const renderer: GroundedAnswerRenderer = {
      render: vi.fn(async () => ({
        answerText: "这是基于群证据得出的推断。",
        evidenceState: "complete_inference" as const,
        confidence: "medium" as const,
      })),
    };
    const orchestrator = createAnswerDraftOrchestrator({
      contextBuilder,
      model: { generateAnswerDraft: vi.fn(async () => ({ answerText: "must not run" })) },
      planner,
      renderer,
    });

    const result = await orchestrator.generateDraft({
      question,
      liveChatMessages: [
        { speaker: "Alice", text: "目标是验证 Quello 的演进路径。" },
        { speaker: "Bob", text: question },
      ],
    });

    expect(planner.plan).toHaveBeenCalledWith(expect.objectContaining({
      evidence: [
        expect.objectContaining({ citationRef: "C1", text: expect.stringContaining("体验积累") }),
        expect.objectContaining({ citationRef: "M1", text: expect.stringContaining("长期记忆") }),
        expect.objectContaining({ citationRef: "T1", text: expect.stringContaining("目标形成") }),
        expect.objectContaining({ citationRef: "D1", text: "Document premise" }),
        expect.objectContaining({ citationRef: "A1", text: expect.stringContaining("验证目标") }),
      ],
      liveChatMessages: [],
    }));
    expect(JSON.stringify(vi.mocked(planner.plan).mock.calls[0]?.[0].evidence))
      .not.toContain(question);
    expect(renderer.render).toHaveBeenCalledWith(expect.objectContaining({
      evidence: [
        expect.objectContaining({ citationRef: "C1" }),
        expect.objectContaining({ citationRef: "M1" }),
        expect.objectContaining({ citationRef: "T1" }),
        expect.objectContaining({ citationRef: "D1" }),
        expect.objectContaining({ citationRef: "A1" }),
      ],
      liveChatMessages: [],
    }));
    expect(result.citedSourceRefs).toEqual(["D1"]);
  });

  it("keeps stale earlier chat out of document retrieval while preserving prompt context", async () => {
    const contextBuilder = {
      buildContext: vi.fn(async (_input: {
        queryText: string;
        supplementalQueryText?: string;
        liveChatMessages: Array<{ speaker: string; text: string }>;
      }) => ({
        promptContext:
          "<background_documents></background_documents>\n\n<live_chat_context></live_chat_context>",
        allowedFragments: [],
        deniedDocumentIds: [],
        retrievedFragmentCount: 0,
        usedGroupMemories: [],
      })),
    };
    const model: ModelProvider = {
      generateAnswerDraft: vi.fn(async () => ({ answerText: "One week early." })),
    };
    const orchestrator = createAnswerDraftOrchestrator({ contextBuilder, model });
    const liveChatMessages = [
      { speaker: "Alice", text: "Revoked document acceptance marker." },
      { speaker: "Bob", text: "What should we discuss?" },
      { speaker: "Carol", text: "Build a cycle reminder app." },
      { speaker: "Alice", text: "It should warn one week early." },
      { speaker: "Bob", text: "Interesting request." },
      { speaker: "Carol", text: "Please answer from the current discussion." },
    ];

    const question = "When should the company reminder warn us?";
    await orchestrator.generateDraft({
      question,
      liveChatMessages,
    });

    const input = contextBuilder.buildContext.mock.calls[0]?.[0];
    expect(input?.queryText).not.toContain("Revoked document acceptance marker.");
    expect(input?.queryText).toBe(question);
    expect(input?.supplementalQueryText).not.toContain("Revoked document acceptance marker.");
    expect(input?.supplementalQueryText).toContain("It should warn one week early.");
    expect(input?.liveChatMessages).toEqual(liveChatMessages);
  });

  it("caps stored live chat loading and context limits to 20 messages", async () => {
    const contextBuilder = {
      buildContext: vi.fn(async () => ({
        promptContext:
          "<background_documents></background_documents>\n\n<live_chat_context></live_chat_context>",
        allowedFragments: [],
        deniedDocumentIds: [],
        retrievedFragmentCount: 0,
        usedGroupMemories: [],
      })),
    };
    const model: ModelProvider = {
      generateAnswerDraft: vi.fn(async () => ({ answerText: "Draft answer." })),
    };
    const liveChatContextProvider = {
      loadRecentMessages: vi.fn(async () => []),
    };
    const orchestrator = createAnswerDraftOrchestrator({
      contextBuilder,
      model,
      liveChatContextProvider,
    });

    await orchestrator.generateDraft({
      question: COMPANY_CONTEXT_QUESTION,
      chatId: "oc_1",
      liveChatMessages: [],
      liveChatLimit: 999,
    });

    expect(liveChatContextProvider.loadRecentMessages).toHaveBeenCalledWith({
      chatId: "oc_1",
      limit: 20,
    });
    expect(contextBuilder.buildContext).toHaveBeenCalledWith(
      expect.objectContaining({ liveChatLimit: 20 }),
    );
  });

  it("caps combined stored and request live chat messages before building context", async () => {
    const contextBuilder = {
      buildContext: vi.fn(async () => ({
        promptContext:
          "<background_documents></background_documents>\n\n<live_chat_context></live_chat_context>",
        allowedFragments: [],
        deniedDocumentIds: [],
        retrievedFragmentCount: 0,
        usedGroupMemories: [],
      })),
    };
    const model: ModelProvider = {
      generateAnswerDraft: vi.fn(async () => ({ answerText: "Draft answer." })),
    };
    const liveChatContextProvider = {
      loadRecentMessages: vi.fn(async () =>
        Array.from({ length: 25 }, (_, index) => ({
          speaker: "Stored",
          text: `stored-${index + 1}`,
        })),
      ),
    };
    const orchestrator = createAnswerDraftOrchestrator({
      contextBuilder,
      model,
      liveChatContextProvider,
    });

    await orchestrator.generateDraft({
      question: COMPANY_CONTEXT_QUESTION,
      chatId: "oc_1",
      liveChatMessages: [{ speaker: "Current", text: "current-1" }],
    });

    expect(contextBuilder.buildContext).toHaveBeenCalledWith(
      expect.objectContaining({
        liveChatMessages: [
          ...Array.from({ length: 19 }, (_, index) => ({
            speaker: "Stored",
            text: `stored-${index + 7}`,
          })),
          { speaker: "Current", text: "current-1" },
        ],
      }),
    );
  });

  it("rejects unsafe liveChatLimit values before loading stored context", async () => {
    const contextBuilder = {
      buildContext: vi.fn(),
    };
    const model: ModelProvider = {
      generateAnswerDraft: vi.fn(),
    };
    const liveChatContextProvider = {
      loadRecentMessages: vi.fn(async () => []),
    };
    const orchestrator = createAnswerDraftOrchestrator({
      contextBuilder,
      model,
      liveChatContextProvider,
    });

    await expect(
      orchestrator.generateDraft({
        question: DIRECT_SUMMARY_QUESTION,
        chatId: "oc_1",
        liveChatMessages: [],
        liveChatLimit: Number.MAX_SAFE_INTEGER + 1,
      }),
    ).rejects.toThrow("liveChatLimit must be a finite safe-magnitude number");
    expect(liveChatContextProvider.loadRecentMessages).not.toHaveBeenCalled();
    expect(contextBuilder.buildContext).not.toHaveBeenCalled();
    expect(model.generateAnswerDraft).not.toHaveBeenCalled();
  });

  it("rejects non-finite liveChatLimit values before loading stored context", async () => {
    const contextBuilder = {
      buildContext: vi.fn(),
    };
    const model: ModelProvider = {
      generateAnswerDraft: vi.fn(),
    };
    const liveChatContextProvider = {
      loadRecentMessages: vi.fn(async () => []),
    };
    const orchestrator = createAnswerDraftOrchestrator({
      contextBuilder,
      model,
      liveChatContextProvider,
    });

    await expect(
      orchestrator.generateDraft({
        question: DIRECT_SUMMARY_QUESTION,
        chatId: "oc_1",
        liveChatMessages: [],
        liveChatLimit: Number.NaN,
      }),
    ).rejects.toThrow("liveChatLimit must be a finite safe-magnitude number");
    expect(liveChatContextProvider.loadRecentMessages).not.toHaveBeenCalled();
    expect(contextBuilder.buildContext).not.toHaveBeenCalled();
    expect(model.generateAnswerDraft).not.toHaveBeenCalled();
  });

  it("rejects oversized request live chat arrays before loading stored context", async () => {
    const contextBuilder = {
      buildContext: vi.fn(),
    };
    const model: ModelProvider = {
      generateAnswerDraft: vi.fn(),
    };
    const liveChatContextProvider = {
      loadRecentMessages: vi.fn(async () => []),
    };
    const orchestrator = createAnswerDraftOrchestrator({
      contextBuilder,
      model,
      liveChatContextProvider,
    });

    await expect(
      orchestrator.generateDraft({
        question: DIRECT_SUMMARY_QUESTION,
        chatId: "oc_1",
        liveChatMessages: Array.from({ length: 51 }, (_, index) => ({
          speaker: "User",
          text: `message-${index + 1}`,
        })),
      }),
    ).rejects.toThrow("liveChatMessages must include at most 50 messages");
    expect(liveChatContextProvider.loadRecentMessages).not.toHaveBeenCalled();
    expect(contextBuilder.buildContext).not.toHaveBeenCalled();
    expect(model.generateAnswerDraft).not.toHaveBeenCalled();
  });

  it("rejects unsafe fragmentLimit values before loading stored context", async () => {
    const contextBuilder = {
      buildContext: vi.fn(),
    };
    const model: ModelProvider = {
      generateAnswerDraft: vi.fn(),
    };
    const liveChatContextProvider = {
      loadRecentMessages: vi.fn(async () => []),
    };
    const orchestrator = createAnswerDraftOrchestrator({
      contextBuilder,
      model,
      liveChatContextProvider,
    });

    await expect(
      orchestrator.generateDraft({
        question: DIRECT_SUMMARY_QUESTION,
        chatId: "oc_1",
        liveChatMessages: [],
        fragmentLimit: Number.MAX_SAFE_INTEGER + 1,
      }),
    ).rejects.toThrow("fragmentLimit must be a finite safe-magnitude number");
    expect(liveChatContextProvider.loadRecentMessages).not.toHaveBeenCalled();
    expect(contextBuilder.buildContext).not.toHaveBeenCalled();
    expect(model.generateAnswerDraft).not.toHaveBeenCalled();
  });

  it("rejects non-finite fragmentLimit values before loading stored context", async () => {
    const contextBuilder = {
      buildContext: vi.fn(),
    };
    const model: ModelProvider = {
      generateAnswerDraft: vi.fn(),
    };
    const liveChatContextProvider = {
      loadRecentMessages: vi.fn(async () => []),
    };
    const orchestrator = createAnswerDraftOrchestrator({
      contextBuilder,
      model,
      liveChatContextProvider,
    });

    await expect(
      orchestrator.generateDraft({
        question: DIRECT_SUMMARY_QUESTION,
        chatId: "oc_1",
        liveChatMessages: [],
        fragmentLimit: Number.POSITIVE_INFINITY,
      }),
    ).rejects.toThrow("fragmentLimit must be a finite safe-magnitude number");
    expect(liveChatContextProvider.loadRecentMessages).not.toHaveBeenCalled();
    expect(contextBuilder.buildContext).not.toHaveBeenCalled();
    expect(model.generateAnswerDraft).not.toHaveBeenCalled();
  });

  it("deduplicates stored and request live chat messages before building context", async () => {
    const contextBuilder = {
      buildContext: vi.fn(async () => ({
        promptContext:
          "<background_documents></background_documents>\n\n<live_chat_context></live_chat_context>",
        allowedFragments: [],
        deniedDocumentIds: [],
        retrievedFragmentCount: 0,
        usedGroupMemories: [],
      })),
    };
    const model: ModelProvider = {
      generateAnswerDraft: vi.fn(async () => ({ answerText: "Draft answer." })),
    };
    const liveChatContextProvider = {
      loadRecentMessages: vi.fn(async () => [
        { speaker: "ou_a", text: "Duplicated context" },
        { speaker: "ou_b", text: "Stored context" },
      ]),
    };
    const orchestrator = createAnswerDraftOrchestrator({
      contextBuilder,
      model,
      liveChatContextProvider,
    });

    await orchestrator.generateDraft({
      question: COMPANY_CONTEXT_QUESTION,
      chatId: "oc_1",
      liveChatMessages: [
        { speaker: "ou_a", text: "Duplicated context" },
        { speaker: "ou_c", text: "Current context" },
      ],
    });

    expect(contextBuilder.buildContext).toHaveBeenCalledWith({
      queryText: COMPANY_CONTEXT_QUESTION,
      supplementalQueryText: expect.stringContaining("Recent live chat:"),
      liveChatMessages: [
        { speaker: "ou_b", text: "Stored context" },
        { speaker: "ou_a", text: "Duplicated context" },
        { speaker: "ou_c", text: "Current context" },
      ],
      fragmentLimit: undefined,
      liveChatLimit: undefined,
    });
  });

  it("deduplicates live chat messages after trimming speaker and text", async () => {
    const contextBuilder = {
      buildContext: vi.fn(async () => ({
        promptContext:
          "<background_documents></background_documents>\n\n<live_chat_context></live_chat_context>",
        allowedFragments: [],
        deniedDocumentIds: [],
        retrievedFragmentCount: 0,
        usedGroupMemories: [],
      })),
    };
    const model: ModelProvider = {
      generateAnswerDraft: vi.fn(async () => ({ answerText: "Draft answer." })),
    };
    const liveChatContextProvider = {
      loadRecentMessages: vi.fn(async () => [
        { speaker: " ou_a ", text: " Duplicated context " },
      ]),
    };
    const orchestrator = createAnswerDraftOrchestrator({
      contextBuilder,
      model,
      liveChatContextProvider,
    });

    await orchestrator.generateDraft({
      question: COMPANY_CONTEXT_QUESTION,
      chatId: "oc_1",
      liveChatMessages: [
        { speaker: "ou_a", text: "Duplicated context" },
        { speaker: " ou_c ", text: " Current context " },
      ],
    });

    expect(contextBuilder.buildContext).toHaveBeenCalledWith({
      queryText: COMPANY_CONTEXT_QUESTION,
      supplementalQueryText: expect.stringContaining("Recent live chat:"),
      liveChatMessages: [
        { speaker: "ou_a", text: "Duplicated context" },
        { speaker: "ou_c", text: "Current context" },
      ],
      fragmentLimit: undefined,
      liveChatLimit: undefined,
    });
  });

  it("keeps the newest duplicate live chat message before applying the context window", async () => {
    const contextBuilder = {
      buildContext: vi.fn(async () => ({
        promptContext:
          "<background_documents></background_documents>\n\n<live_chat_context></live_chat_context>",
        allowedFragments: [],
        deniedDocumentIds: [],
        retrievedFragmentCount: 0,
        usedGroupMemories: [],
      })),
    };
    const model: ModelProvider = {
      generateAnswerDraft: vi.fn(async () => ({ answerText: "Draft answer." })),
    };
    const storedMessages = [
      { speaker: "ou_a", text: "Repeated current request" },
      ...Array.from({ length: 19 }, (_, index) => ({
        speaker: `ou_${index}`,
        text: `stored-${index}`,
      })),
    ];
    const liveChatContextProvider = {
      loadRecentMessages: vi.fn(async () => storedMessages),
    };
    const orchestrator = createAnswerDraftOrchestrator({
      contextBuilder,
      model,
      liveChatContextProvider,
    });

    await orchestrator.generateDraft({
      question: COMPANY_CONTEXT_QUESTION,
      chatId: "oc_1",
      liveChatMessages: [{ speaker: "ou_a", text: "Repeated current request" }],
      liveChatLimit: 20,
    });

    expect(contextBuilder.buildContext).toHaveBeenCalledWith({
      queryText: COMPANY_CONTEXT_QUESTION,
      supplementalQueryText: expect.stringContaining("Recent live chat:"),
      liveChatMessages: [
        ...storedMessages.slice(1),
        { speaker: "ou_a", text: "Repeated current request" },
      ],
      fragmentLimit: undefined,
      liveChatLimit: 20,
    });
  });

  it("truncates oversized live chat messages before building context", async () => {
    let observedLiveChatMessages: Array<{ speaker: string; text: string }> | undefined;
    const contextBuilder = {
      buildContext: vi.fn(
        async (input: { liveChatMessages: Array<{ speaker: string; text: string }> }) => {
          observedLiveChatMessages = input.liveChatMessages;
          return {
            promptContext:
              "<background_documents></background_documents>\n\n<live_chat_context></live_chat_context>",
            allowedFragments: [],
            deniedDocumentIds: [],
            retrievedFragmentCount: 0,
            usedGroupMemories: [],
          };
        },
      ),
    };
    const model: ModelProvider = {
      generateAnswerDraft: vi.fn(async () => ({ answerText: "Draft answer." })),
    };
    const orchestrator = createAnswerDraftOrchestrator({
      contextBuilder,
      model,
    });

    await orchestrator.generateDraft({
      question: COMPANY_CONTEXT_QUESTION,
      liveChatMessages: [
        {
          speaker: `${"S".repeat(400)} trailing speaker detail`,
          text: `${"T".repeat(2500)} trailing message detail`,
        },
      ],
    });

    expect(observedLiveChatMessages?.[0]?.speaker.length).toBeLessThanOrEqual(256);
    expect(observedLiveChatMessages?.[0]?.speaker).toContain("[truncated]");
    expect(observedLiveChatMessages?.[0]?.speaker).not.toContain("trailing speaker detail");
    expect(observedLiveChatMessages?.[0]?.text.length).toBeLessThanOrEqual(2000);
    expect(observedLiveChatMessages?.[0]?.text).toContain("[truncated]");
    expect(observedLiveChatMessages?.[0]?.text).not.toContain("trailing message detail");
  });

  it("rejects blank model output", async () => {
    const orchestrator = createAnswerDraftOrchestrator({
      contextBuilder: {
        buildContext: vi.fn(async () => ({
          promptContext: "<background_documents></background_documents>",
          allowedFragments: [],
          deniedDocumentIds: [],
          retrievedFragmentCount: 0,
          usedGroupMemories: [],
        })),
      },
      model: { generateAnswerDraft: vi.fn(async () => ({ answerText: " \n " })) },
    });

    await expect(
      orchestrator.generateDraft({ question: DIRECT_SUMMARY_QUESTION, liveChatMessages: [] }),
    ).rejects.toThrow("model answer draft must not be blank");
  });

  it("truncates oversized model output before returning answer drafts", async () => {
    const orchestrator = createAnswerDraftOrchestrator({
      contextBuilder: {
        buildContext: vi.fn(async () => ({
          promptContext: "<background_documents></background_documents>",
          allowedFragments: [],
          deniedDocumentIds: [],
          retrievedFragmentCount: 0,
          usedGroupMemories: [],
        })),
      },
      model: {
        generateAnswerDraft: vi.fn(async () => ({
          answerText: `${"A".repeat(9000)} trailing model output`,
        })),
      },
    });

    const result = await orchestrator.generateDraft({
      question: DIRECT_SUMMARY_QUESTION,
      liveChatMessages: [],
    });

    expect(result.answerText.length).toBeLessThanOrEqual(8000);
    expect(result.answerText).toContain("[truncated]");
    expect(result.answerText).not.toContain("trailing model output");
  });

  it("records a content-free answer and provider lifecycle with a stable execution ID", async () => {
    const observe = vi.fn<AgentExecutionObserver["observe"]>(async () => undefined);
    const contextBuilder = {
      buildContext: vi.fn(async () => ({
        promptContext: "SECRET_PROMPT_CONTEXT",
        allowedFragments: [
          {
            id: "fragment-1",
            documentSourceId: "source-1",
            documentSnapshotId: "snapshot-1",
            sourceUri: "https://example.com/doc",
            chunkIndex: 0,
            text: "SECRET_DOCUMENT_BODY",
            contentHash: "hash",
            embedding: [1, 0, 0, 0, 0, 0],
            embeddingProfileId: "static-dev-6d",
            createdAt: new Date("2026-07-27T00:00:00.000Z"),
            sourceType: "feishu_wiki" as const,
          },
        ],
        deniedDocumentIds: [],
        retrievedFragmentCount: 2,
        usedGroupMemories: [{
          id: "memory-1",
          scope: "group" as const,
          category: "decision" as const,
          content: "SECRET_MEMORY_BODY",
          evidenceMessageIds: ["message-1"],
        }],
        usedDiscussionThreads: [{
          id: "thread-1",
          summary: "SECRET_THREAD_BODY",
          status: "open" as const,
          evidenceMessageIds: ["message-2"],
        }],
        usedActionItems: [{
          id: "action-1",
          description: "SECRET_ACTION_BODY",
          ownerRef: "ou_alice",
          status: "open" as const,
          evidenceMessageIds: ["message-3"],
        }],
      })),
    };
    const orchestrator = createAnswerDraftOrchestrator({
      contextBuilder,
      model: {
        generateAnswerDraft: vi.fn(async () => ({
          answerText: "SECRET_MODEL_ANSWER",
        })),
      },
      agentExecutionObserver: { observe },
      provider: "google",
      modelId: "gemini-2.5-flash",
    });

    await orchestrator.generateDraft({
      executionId: "om_message_1",
      question: "Please summarize this text: SECRET_QUESTION",
      chatId: "oc_group_1",
      askerId: "ou_alice",
      liveChatMessages: [],
    });

    expect(observe.mock.calls.map(([event]) => event)).toEqual([
      {
        groupId: "oc_group_1",
        actorOpenId: "ou_alice",
        subjectType: "turn",
        subjectId: "om_message_1",
        eventType: "turn_started",
        phase: "context_assembly",
        operationKey: "turn:om_message_1:started",
        metadata: {},
      },
      {
        groupId: "oc_group_1",
        actorOpenId: "ou_alice",
        subjectType: "provider_request",
        subjectId: "om_message_1",
        eventType: "provider_request_started",
        phase: "sampling",
        provider: "google",
        modelId: "gemini-2.5-flash",
        operationKey: "turn:om_message_1:provider:renderer:started",
        metadata: { stage: "answer_rendering" },
      },
      {
        groupId: "oc_group_1",
        actorOpenId: "ou_alice",
        subjectType: "provider_request",
        subjectId: "om_message_1",
        eventType: "provider_request_completed",
        phase: "sampling",
        provider: "google",
        modelId: "gemini-2.5-flash",
        outcome: "success",
        operationKey: "turn:om_message_1:provider:renderer:completed",
        metadata: { stage: "answer_rendering" },
      },
      {
        groupId: "oc_group_1",
        actorOpenId: "ou_alice",
        subjectType: "turn",
        subjectId: "om_message_1",
        eventType: "turn_completed",
        phase: "completed",
        outcome: "success",
        operationKey: "turn:om_message_1:completed",
        metadata: {
          retrievedFragmentCount: 0,
          allowedFragmentCount: 0,
          deniedDocumentCount: 0,
          groupMemoryCount: 0,
          discussionThreadCount: 0,
          actionItemCount: 0,
          taskMode: "direct_task",
        },
      },
    ]);
    expect(contextBuilder.buildContext).not.toHaveBeenCalled();
    expect(JSON.stringify(observe.mock.calls)).not.toContain("SECRET_");
  });

  it("records distinct content-free planner and renderer provider stages", async () => {
    const observe = vi.fn<AgentExecutionObserver["observe"]>(async () => undefined);
    const orchestrator = createAnswerDraftOrchestrator({
      contextBuilder: {
        buildContext: vi.fn(async () => ({
          promptContext: "SECRET_PROMPT_CONTEXT",
          allowedFragments: [retrievedFragment("secret-source", "SECRET_DOCUMENT_BODY", 0)],
          deniedDocumentIds: [],
          retrievedFragmentCount: 1,
          liveChatMessages: [],
          usedGroupMemories: [],
        })),
      },
      model: {
        generateAnswerDraft: vi.fn(async () => ({ answerText: "must not run" })),
      },
      planner: {
        plan: vi.fn<EvidencePlanner["plan"]>(async () => ({
          taskMode: "company_fact",
          evidenceState: "explicit",
          premises: [{ citationRef: "D1", statement: "SECRET_PREMISE" }],
          proposedAnswer: "SECRET_PROPOSED_ANSWER",
          missingInformation: [],
          confidence: "high",
        })),
      },
      renderer: {
        render: vi.fn<GroundedAnswerRenderer["render"]>(async () => ({
          answerText: "Rendered answer.",
          evidenceState: "explicit",
          confidence: "high",
        })),
      },
      agentExecutionObserver: { observe },
      provider: "google",
      modelId: "gemini-2.5-flash",
    });

    await orchestrator.generateDraft({
      executionId: "om_reasoning_1",
      question: "SECRET_QUESTION",
      liveChatMessages: [],
    });

    expect(observe.mock.calls
      .map(([event]) => event)
      .filter(({ subjectType }) => subjectType === "provider_request")
      .map(({ eventType, operationKey, metadata }) => ({ eventType, operationKey, metadata })))
      .toEqual([
        {
          eventType: "provider_request_started",
          operationKey: "turn:om_reasoning_1:provider:planner:started",
          metadata: { stage: "evidence_planning" },
        },
        {
          eventType: "provider_request_completed",
          operationKey: "turn:om_reasoning_1:provider:planner:completed",
          metadata: { stage: "evidence_planning" },
        },
        {
          eventType: "provider_request_started",
          operationKey: "turn:om_reasoning_1:provider:renderer:started",
          metadata: { stage: "answer_rendering" },
        },
        {
          eventType: "provider_request_completed",
          operationKey: "turn:om_reasoning_1:provider:renderer:completed",
          metadata: { stage: "answer_rendering" },
        },
      ]);
    expect(observe.mock.calls
      .map(([event]) => event)
      .find(({ eventType }) => eventType === "turn_completed")?.metadata)
      .toEqual(expect.objectContaining({
        taskMode: "company_fact",
        evidenceState: "explicit",
        confidence: "high",
      }));
    expect(JSON.stringify(observe.mock.calls)).not.toContain("SECRET_");
  });

  it("records provider and turn failures without logging upstream error content", async () => {
    const observe = vi.fn<AgentExecutionObserver["observe"]>(async () => undefined);
    const upstreamError = new Error("SECRET_UPSTREAM_ERROR");
    const orchestrator = createAnswerDraftOrchestrator({
      contextBuilder: {
        buildContext: vi.fn(async () => ({
          promptContext: "<background_documents></background_documents>",
          allowedFragments: [],
          deniedDocumentIds: [],
          retrievedFragmentCount: 0,
          usedGroupMemories: [],
        })),
      },
      model: {
        generateAnswerDraft: vi.fn(async () => {
          throw upstreamError;
        }),
      },
      agentExecutionObserver: { observe },
    });

    await expect(orchestrator.generateDraft({
      executionId: "turn-failed-1",
      question: DIRECT_SUMMARY_QUESTION,
      liveChatMessages: [],
    })).rejects.toBe(upstreamError);

    expect(observe.mock.calls.map(([event]) => event.eventType)).toEqual([
      "turn_started",
      "provider_request_started",
      "provider_request_failed",
      "turn_failed",
    ]);
    expect(observe.mock.calls[2]?.[0]).toEqual(expect.objectContaining({
      outcome: "error",
      decisionReason: "model_provider_failed",
      metadata: { stage: "answer_rendering" },
    }));
    expect(observe.mock.calls[3]?.[0]).toEqual(expect.objectContaining({
      outcome: "error",
      decisionReason: "answer_draft_failed",
      metadata: {},
    }));
    expect(JSON.stringify(observe.mock.calls)).not.toContain("SECRET_UPSTREAM_ERROR");
  });

  it("keeps answer generation successful when execution observation fails", async () => {
    const orchestrator = createAnswerDraftOrchestrator({
      contextBuilder: {
        buildContext: vi.fn(async () => ({
          promptContext: "<background_documents></background_documents>",
          allowedFragments: [],
          deniedDocumentIds: [],
          retrievedFragmentCount: 0,
          usedGroupMemories: [],
        })),
      },
      model: {
        generateAnswerDraft: vi.fn(async () => ({ answerText: "Answer." })),
      },
      agentExecutionObserver: {
        observe: vi.fn(async () => {
          throw new Error("ledger unavailable");
        }),
      },
      createExecutionId: () => "generated-turn-1",
    });

    await expect(orchestrator.generateDraft({
      question: DIRECT_SUMMARY_QUESTION,
      liveChatMessages: [],
    })).resolves.toEqual(expect.objectContaining({ answerText: "Answer." }));
  });
});

function retrievedFragment(id: string, text: string, chunkIndex: number) {
  return {
    id,
    documentSourceId: `source-${id}`,
    documentSnapshotId: `snapshot-${id}`,
    sourceUri: `https://example.com/${id}`,
    chunkIndex,
    text,
    contentHash: `hash-${id}`,
    embedding: [1, 0, 0, 0, 0, 0],
    embeddingProfileId: "static-dev-6d",
    createdAt: new Date("2026-08-11T00:00:00.000Z"),
    sourceType: "feishu_wiki" as const,
  };
}
