import { describe, expect, it, vi } from "vitest";

import {
  createAnswerDraftOrchestrator,
  type ModelProvider,
} from "../src/agent/answer-draft-orchestrator.js";

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
          },
        ],
        deniedDocumentIds: ["source-denied"],
        retrievedFragmentCount: 2,
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
      queryText: "What changed?",
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
      deniedDocumentIds: ["source-denied"],
      retrievedFragmentCount: 2,
    });
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

  it("loads stored live chat context when chatId is supplied", async () => {
    const contextBuilder = {
      buildContext: vi.fn(async () => ({
        promptContext:
          "<background_documents></background_documents>\n\n<live_chat_context></live_chat_context>",
        allowedFragments: [],
        deniedDocumentIds: [],
        retrievedFragmentCount: 0,
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
      queryText: "What changed?",
      liveChatMessages: [
        { speaker: "ou_a", text: "Stored context" },
        { speaker: "ou_b", text: "Current question context" },
      ],
      fragmentLimit: undefined,
      liveChatLimit: 8,
    });
  });

  it("caps stored live chat loading and context limits to 20 messages", async () => {
    const contextBuilder = {
      buildContext: vi.fn(async () => ({
        promptContext:
          "<background_documents></background_documents>\n\n<live_chat_context></live_chat_context>",
        allowedFragments: [],
        deniedDocumentIds: [],
        retrievedFragmentCount: 0,
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

  it("deduplicates stored and request live chat messages before building context", async () => {
    const contextBuilder = {
      buildContext: vi.fn(async () => ({
        promptContext:
          "<background_documents></background_documents>\n\n<live_chat_context></live_chat_context>",
        allowedFragments: [],
        deniedDocumentIds: [],
        retrievedFragmentCount: 0,
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
      queryText: "What changed?",
      liveChatMessages: [
        { speaker: "ou_a", text: "Duplicated context" },
        { speaker: "ou_b", text: "Stored context" },
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
      queryText: "What changed?",
      liveChatMessages: [
        { speaker: "ou_a", text: "Duplicated context" },
        { speaker: "ou_c", text: "Current context" },
      ],
      fragmentLimit: undefined,
      liveChatLimit: undefined,
    });
  });

  it("rejects blank model output", async () => {
    const orchestrator = createAnswerDraftOrchestrator({
      contextBuilder: {
        buildContext: vi.fn(async () => ({
          promptContext: "<background_documents></background_documents>",
          allowedFragments: [],
          deniedDocumentIds: [],
          retrievedFragmentCount: 0,
        })),
      },
      model: { generateAnswerDraft: vi.fn(async () => ({ answerText: " \n " })) },
    });

    await expect(
      orchestrator.generateDraft({ question: "What changed?", liveChatMessages: [] }),
    ).rejects.toThrow("model answer draft must not be blank");
  });
});
