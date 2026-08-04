import { describe, expect, it, vi } from "vitest";

import {
  createAnswerDraftOrchestrator,
  type ModelProvider,
} from "../src/agent/answer-draft-orchestrator.js";
import type { AgentExecutionObserver } from "../src/agent-runtime/agent-execution-observer.js";

describe("AnswerDraftOrchestrator", () => {
  it("builds safe context, calls model provider, and returns draft metadata", async () => {
    const contextBuilder = {
      buildContext: vi.fn(async () => ({
        promptContext:
          "<background_documents></background_documents>\n\n<live_chat_context></live_chat_context>",
        allowedFragments: [
          {
            id: "fragment-1",
            documentSourceId: "source-1",
            documentSnapshotId: "snapshot-1",
            sourceUri: "https://example.com/doc",
            chunkIndex: 0,
            text: "Allowed text",
            contentHash: "hash",
            embedding: [1, 0, 0, 0, 0, 0],
            embeddingProfileId: "static-dev-6d",
            createdAt: new Date("2026-07-02T01:00:00.000Z"),
            sourceType: "feishu_wiki" as const,
          },
        ],
        deniedDocumentIds: [],
        retrievedFragmentCount: 2,
        usedGroupMemories: [{
          id: "memory-1",
          scope: "group" as const,
          category: "decision" as const,
          content: "Launch Thursday.",
          evidenceMessageIds: ["msg-1"],
        }],
      })),
    };
    const model: ModelProvider = {
      generateAnswerDraft: vi.fn(async () => ({ answerText: "  Draft answer.  " })),
    };
    const orchestrator = createAnswerDraftOrchestrator({ contextBuilder, model });

    const result = await orchestrator.generateDraft({
      question: "What changed?",
      liveChatMessages: [{ speaker: "Alice", text: "Please answer." }],
      fragmentLimit: 4,
      liveChatLimit: 10,
    });

    expect(contextBuilder.buildContext).toHaveBeenCalledWith({
      queryText: expect.stringContaining("What changed?"),
      liveChatMessages: [{ speaker: "Alice", text: "Please answer." }],
      fragmentLimit: 4,
      liveChatLimit: 10,
    });
    expect(model.generateAnswerDraft).toHaveBeenCalledWith({
      question: "What changed?",
      promptContext:
        "<background_documents></background_documents>\n\n<live_chat_context></live_chat_context>",
    });
    expect(result).toEqual({
      answerText: "Draft answer.",
      promptContext:
        "<background_documents></background_documents>\n\n<live_chat_context></live_chat_context>",
      allowedFragments: [
        expect.objectContaining({ id: "fragment-1", documentSourceId: "source-1" }),
      ],
      deniedDocumentIds: [],
      retrievedFragmentCount: 2,
      usedGroupMemories: [{
        id: "memory-1",
        scope: "group",
        category: "decision",
        content: "Launch Thursday.",
        evidenceMessageIds: ["msg-1"],
      }],
      usedDiscussionThreads: [],
      usedActionItems: [],
    });
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
    const orchestrator = createAnswerDraftOrchestrator({ contextBuilder, model });

    const result = await orchestrator.generateDraft({
      question: "What changed?",
      liveChatMessages: [],
    });

    expect(model.generateAnswerDraft).not.toHaveBeenCalled();
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
      question: "What changed?",
      liveChatMessages: [],
    });

    expect(result).toEqual({ blockedDocumentSourceIds: ["source-denied"] });
    expect(contextBuilder.buildContext).toHaveBeenCalledTimes(1);
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
      question: "What changed?",
      chatId: "oc_1",
      liveChatMessages: [{ speaker: "ou_b", text: "Current question context" }],
      liveChatLimit: 8,
    });

    expect(liveChatContextProvider.loadRecentMessages).toHaveBeenCalledWith({
      chatId: "oc_1",
      limit: 8,
    });
    expect(contextBuilder.buildContext).toHaveBeenCalledWith({
      queryText: expect.stringContaining("What changed?"),
      liveChatMessages: [
        { speaker: "ou_a", text: "Stored context" },
        { speaker: "ou_b", text: "Current question context" },
      ],
      fragmentLimit: undefined,
      liveChatLimit: 8,
    });
  });

  it("includes live chat context in retrieval query text for follow-up questions", async () => {
    const contextBuilder = {
      buildContext: vi.fn(async (_input: { queryText: string }) => ({
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

    await orchestrator.generateDraft({
      question: "What about this?",
      liveChatMessages: [
        { speaker: "Alice", text: "Project Alpha launch moved to next Wednesday." },
        { speaker: "Bob", text: "The risk is that design acceptance is not done." },
      ],
    });

    const queryText = contextBuilder.buildContext.mock.calls[0]?.[0].queryText ?? "";
    expect(queryText).toContain("What about this?");
    expect(queryText).toContain("Alice: Project Alpha launch moved to next Wednesday.");
    expect(queryText).toContain("Bob: The risk is that design acceptance is not done.");
    expect(queryText.length).toBeLessThanOrEqual(4000);
  });

  it("keeps stale earlier chat out of document retrieval while preserving prompt context", async () => {
    const contextBuilder = {
      buildContext: vi.fn(async (_input: {
        queryText: string;
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

    await orchestrator.generateDraft({
      question: "How early should it remind us?",
      liveChatMessages,
    });

    const input = contextBuilder.buildContext.mock.calls[0]?.[0];
    expect(input?.queryText).not.toContain("Revoked document acceptance marker.");
    expect(input?.queryText).toContain("It should warn one week early.");
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
      question: "What changed?",
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
      question: "What changed?",
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
        question: "What changed?",
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
        question: "What changed?",
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
        question: "What changed?",
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
        question: "What changed?",
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
        question: "What changed?",
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
      question: "What changed?",
      chatId: "oc_1",
      liveChatMessages: [
        { speaker: "ou_a", text: "Duplicated context" },
        { speaker: "ou_c", text: "Current context" },
      ],
    });

    expect(contextBuilder.buildContext).toHaveBeenCalledWith({
      queryText: expect.stringContaining("What changed?"),
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
      question: "What changed?",
      chatId: "oc_1",
      liveChatMessages: [
        { speaker: "ou_a", text: "Duplicated context" },
        { speaker: " ou_c ", text: " Current context " },
      ],
    });

    expect(contextBuilder.buildContext).toHaveBeenCalledWith({
      queryText: expect.stringContaining("What changed?"),
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
      question: "What changed?",
      chatId: "oc_1",
      liveChatMessages: [{ speaker: "ou_a", text: "Repeated current request" }],
      liveChatLimit: 20,
    });

    expect(contextBuilder.buildContext).toHaveBeenCalledWith({
      queryText: expect.stringContaining("What changed?"),
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
      question: "What changed?",
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
      orchestrator.generateDraft({ question: "What changed?", liveChatMessages: [] }),
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
      question: "What changed?",
      liveChatMessages: [],
    });

    expect(result.answerText.length).toBeLessThanOrEqual(8000);
    expect(result.answerText).toContain("[truncated]");
    expect(result.answerText).not.toContain("trailing model output");
  });

  it("records a content-free answer and provider lifecycle with a stable execution ID", async () => {
    const observe = vi.fn<AgentExecutionObserver["observe"]>(async () => undefined);
    const orchestrator = createAnswerDraftOrchestrator({
      contextBuilder: {
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
      },
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
      question: "SECRET_QUESTION",
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
        operationKey: "turn:om_message_1:provider:started",
        metadata: {},
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
        operationKey: "turn:om_message_1:provider:completed",
        metadata: {},
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
          retrievedFragmentCount: 2,
          allowedFragmentCount: 1,
          deniedDocumentCount: 0,
          groupMemoryCount: 1,
          discussionThreadCount: 1,
          actionItemCount: 1,
        },
      },
    ]);
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
      question: "What changed?",
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
      metadata: {},
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
      question: "What changed?",
      liveChatMessages: [],
    })).resolves.toEqual(expect.objectContaining({ answerText: "Answer." }));
  });
});
