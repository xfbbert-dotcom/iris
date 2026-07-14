import { describe, expect, it, vi } from "vitest";

import { InMemoryAuditLog } from "../src/audit/audit-log.js";
import type { GenerateAnswerDraftInput } from "../src/agent/answer-draft-orchestrator.js";
import type { RetrievedDocumentFragment } from "../src/documents/document-fragment-repository.js";
import type { DocumentSource } from "../src/documents/document-source-registry.js";
import type { EmbeddingProfile } from "../src/documents/embedding-profile-repository.js";
import type { GroupMemoryService } from "../src/memory/group-memory-service.js";
import { createAnswerDraftRuntime } from "../src/runtime/answer-draft-runtime.js";

describe("createAnswerDraftRuntime", () => {
  it("returns undefined when runtime is disabled", () => {
    expect(createAnswerDraftRuntime({ env: {} })).toBeUndefined();
  });

  it("preflights answer live permission config before opening resources", () => {
    const createPostgresPool = vi.fn(() => ({
      query: vi.fn(),
      end: vi.fn(async () => undefined),
    }));

    expect(() =>
      createAnswerDraftRuntime({
        env: {
          ...enabledEnv(),
          IRIS_INTERNAL_DRAFT_PERMISSION_MODE: "source-policy",
          FEISHU_APP_ID: "app-id",
        },
        dependencies: {
          createPostgresPool,
        },
      }),
    ).toThrow("FEISHU_APP_SECRET is required");

    expect(createPostgresPool).not.toHaveBeenCalled();
  });

  it("composes runtime dependencies when explicitly enabled", async () => {
    const pool = { query: vi.fn(), end: vi.fn(async () => undefined) };
    const conversationMessages = { listRecentByChat: vi.fn(async () => []) };
    const liveChatContextProvider = { loadRecentMessages: vi.fn(async () => []) };
    const dependencies = {
      createPostgresPool: vi.fn(() => pool),
      createDocumentFragmentRepository: vi.fn(() => ({
        searchSimilarFragments: vi.fn(async () => []),
      })),
      createConversationMessageRepository: vi.fn(() => conversationMessages),
      createLiveChatContextProvider: vi.fn(() => liveChatContextProvider),
      createModelProvider: vi.fn(() => ({
        generateAnswerDraft: vi.fn(async () => ({ answerText: "Draft" })),
      })),
      createEmbeddingProfileRepository: vi.fn(() => ({
        getStaticDevelopmentProfile: vi.fn(async () => profile()),
        findOrCreateProfile: vi.fn(),
        getProfileById: vi.fn(),
      })),
    };

    const runtime = createAnswerDraftRuntime({
      env: {
        IRIS_ENABLE_INTERNAL_ANSWER_DRAFTS: "true",
        IRIS_INTERNAL_DRAFT_PERMISSION_MODE: "allow-indexed",
        DATABASE_URL: "postgres://iris:iris@localhost:5432/iris",
        IRIS_MODEL_PROVIDER: "openai-compatible",
        IRIS_MODEL_BASE_URL: "https://api.example.com/v1",
        IRIS_MODEL_API_KEY: "key-a",
        IRIS_MODEL_NAME: "model-a",
      },
      dependencies,
    });

    expect(runtime).toBeDefined();
    expect(dependencies.createPostgresPool).toHaveBeenCalledWith({
      databaseUrl: "postgres://iris:iris@localhost:5432/iris",
    });
    expect(dependencies.createDocumentFragmentRepository).toHaveBeenCalledWith({
      queryable: pool,
      embeddingProfiles: expect.objectContaining({
        getProfileById: expect.any(Function),
      }),
    });
    expect(dependencies.createConversationMessageRepository).toHaveBeenCalledWith({
      queryable: pool,
    });
    expect(dependencies.createLiveChatContextProvider).toHaveBeenCalledWith({
      repository: conversationMessages,
    });
    expect(dependencies.createModelProvider).toHaveBeenCalledWith({
      provider: "openai-compatible",
      baseUrl: "https://api.example.com/v1",
      apiKey: "key-a",
      model: "model-a",
      timeoutMs: 30000,
    });

    await runtime?.close();
    expect(pool.end).toHaveBeenCalled();
  });

  it("exposes a group memory service when the Postgres pool supports transactions", async () => {
    const pool = {
      query: vi.fn(),
      connect: vi.fn(),
      end: vi.fn(async () => undefined),
    };
    const repository = { repository: true };
    const groupMemoryService = { service: true } as unknown as GroupMemoryService;
    const createGroupMemoryRepository = vi.fn(() => repository as never);
    const createGroupMemoryService = vi.fn(() => groupMemoryService);

    const runtime = createAnswerDraftRuntime({
      env: enabledEnv(),
      dependencies: {
        createPostgresPool: vi.fn(() => pool),
        createGroupMemoryRepository,
        createGroupMemoryService,
        createDocumentFragmentRepository: vi.fn(() => ({
          searchSimilarFragments: vi.fn(async () => []),
        })),
        createModelProvider: vi.fn(() => ({
          generateAnswerDraft: vi.fn(async () => ({ answerText: "Draft" })),
        })),
        createEmbeddingProfileRepository: vi.fn(() => ({
          getStaticDevelopmentProfile: vi.fn(async () => profile()),
          findOrCreateProfile: vi.fn(),
          getProfileById: vi.fn(),
        })),
      },
    });

    expect(createGroupMemoryRepository).toHaveBeenCalledWith({ dataSource: pool });
    expect(createGroupMemoryService).toHaveBeenCalledWith({ repository });
    expect(runtime?.groupMemoryService).toBe(groupMemoryService);

    await runtime?.close();
  });

  it("creates a working orchestrator with allow-indexed development permissions", async () => {
    const model = {
      generateAnswerDraft: vi.fn(async () => ({ answerText: "Runtime draft" })),
    };
    const fragments = {
      searchSimilarFragments: vi.fn(async () => [
        {
          id: "fragment-1",
          documentSourceId: "source-1",
          documentSnapshotId: "snapshot-1",
          sourceUri: "https://example.com/doc",
          chunkIndex: 0,
          text: "Indexed text",
          contentHash: "hash",
          embedding: [1, 0, 0, 0, 0, 0],
          embeddingProfileId: "static-dev-6d",
          createdAt: new Date("2026-07-02T01:00:00.000Z"),
        },
      ]),
    };
    const runtime = createAnswerDraftRuntime({
      env: enabledEnv(),
      dependencies: {
        createPostgresPool: vi.fn(() => ({ query: vi.fn(), end: vi.fn(async () => undefined) })),
        createDocumentFragmentRepository: vi.fn(() => fragments),
        createModelProvider: vi.fn(() => model),
        createEmbeddingProfileRepository: vi.fn(() => ({
          getStaticDevelopmentProfile: vi.fn(async () => profile()),
          findOrCreateProfile: vi.fn(),
          getProfileById: vi.fn(),
        })),
      },
    });

    const result = await runtime?.answerDraftOrchestrator.generateDraft({
      question: "What changed?",
      liveChatMessages: [{ speaker: "Alice", text: "Please answer." }],
    });

    expect(result?.answerText).toBe("Runtime draft");
    expect(fragments.searchSimilarFragments).toHaveBeenCalledWith({
      embeddingProfileId: "static-dev-6d",
      embedding: [1, 0, 0, 0, 0, 0],
      limit: 24,
    });
    expect(model.generateAnswerDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        question: "What changed?",
      }),
    );
  });

  it("preserves unrestricted indexed documents with runtime controls in allow-indexed mode", async () => {
    const model = {
      generateAnswerDraft: vi.fn(async () => ({ answerText: "Runtime draft" })),
    };
    const fragments = {
      searchSimilarFragments: vi.fn(async () => [
        fragment({
          id: "fragment-other-group",
          documentSourceId: "source-other-group",
          text: "Development indexed text",
        }),
      ]),
    };
    const runtime = createAnswerDraftRuntime({
      env: enabledEnv(),
      runtimeController: {
        canReadDocuments: vi.fn(() => true),
        canRetrieveKnowledgeBase: vi.fn(() => true),
        canProcessGroupMessage: vi.fn(() => false),
      },
      dependencies: {
        createPostgresPool: vi.fn(() => ({ query: vi.fn(), end: vi.fn(async () => undefined) })),
        createDocumentFragmentRepository: vi.fn(() => fragments),
        createLiveChatContextProvider: vi.fn(() => ({
          loadRecentMessages: vi.fn(async () => []),
        })),
        createModelProvider: vi.fn(() => model),
        createEmbeddingProfileRepository: vi.fn(() => ({
          getStaticDevelopmentProfile: vi.fn(async () => profile()),
          findOrCreateProfile: vi.fn(),
          getProfileById: vi.fn(),
        })),
      },
    });

    const result = await runtime?.answerDraftOrchestrator.generateDraft({
      question: "What can Iris use?",
      chatId: "chat-current",
      liveChatMessages: [],
    });

    expect(result?.allowedFragments.map((item) => item.id)).toEqual(["fragment-other-group"]);
    expect(fragments.searchSimilarFragments).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceTypes: [
          "group_visible_document",
          "authorized_wiki_document",
          "user_submitted_document",
        ],
      }),
    );
    expect(fragments.searchSimilarFragments).not.toHaveBeenCalledWith(
      expect.objectContaining({ groupId: expect.anything() }),
    );
  });

  it("does not load stored live chat context when group context reading is disabled", async () => {
    const model = {
      generateAnswerDraft: vi.fn(async (_input: GenerateAnswerDraftInput) => ({
        answerText: "Runtime draft",
      })),
    };
    const liveChatContextProvider = {
      loadRecentMessages: vi.fn(async () => [
        { speaker: "Alice", text: "Historical group context should stay hidden." },
      ]),
    };
    const runtimeController = {
      canReadDocuments: vi.fn(() => true),
      canRetrieveKnowledgeBase: vi.fn(() => true),
      canReadGroupContext: vi.fn(() => false),
    };
    const runtime = createAnswerDraftRuntime({
      env: enabledEnv(),
      runtimeController,
      dependencies: {
        createPostgresPool: vi.fn(() => ({ query: vi.fn(), end: vi.fn(async () => undefined) })),
        createDocumentFragmentRepository: vi.fn(() => ({ searchSimilarFragments: vi.fn(async () => []) })),
        createLiveChatContextProvider: vi.fn(() => liveChatContextProvider),
        createModelProvider: vi.fn(() => model),
        createEmbeddingProfileRepository: vi.fn(() => ({
          getStaticDevelopmentProfile: vi.fn(async () => profile()),
          findOrCreateProfile: vi.fn(),
          getProfileById: vi.fn(),
        })),
      },
    });

    await runtime?.answerDraftOrchestrator.generateDraft({
      question: "What should Iris say?",
      chatId: "chat-muted",
      liveChatMessages: [{ speaker: "Bob", text: "Current explicit request context." }],
    });

    const promptContext = model.generateAnswerDraft.mock.calls[0]?.[0].promptContext ?? "";
    expect(runtimeController.canReadGroupContext).toHaveBeenCalledWith("chat-muted");
    expect(liveChatContextProvider.loadRecentMessages).not.toHaveBeenCalled();
    expect(promptContext).not.toContain("Historical group context should stay hidden.");
    expect(promptContext).toContain("Current explicit request context.");
  });

  it("filters answer draft fragments through local source policy", async () => {
    const model = {
      generateAnswerDraft: vi.fn(
        async (_input: { question: string; promptContext: string }) => ({
          answerText: "Runtime draft",
        }),
      ),
    };
    const fragments = {
      searchSimilarFragments: vi.fn(async () => [
        fragment({
          id: "fragment-allowed",
          documentSourceId: "source-allowed",
          text: "Allowed text",
        }),
        fragment({
          id: "fragment-disabled",
          documentSourceId: "source-disabled",
          text: "Disabled text",
        }),
        fragment({
          id: "fragment-denied",
          documentSourceId: "source-denied",
          text: "Denied text",
        }),
        fragment({
          id: "fragment-stale",
          documentSourceId: "source-stale",
          text: "Stale text",
        }),
        fragment({
          id: "fragment-missing",
          documentSourceId: "source-missing",
          text: "Missing text",
        }),
        fragment({
          id: "fragment-error",
          documentSourceId: "source-error",
          text: "Error text",
        }),
      ]),
    };
    const sources: Record<string, DocumentSource | undefined> = {
      "source-allowed": source({
        id: "source-allowed",
        sourceType: "user_submitted_document",
        permissionState: "readable",
      }),
      "source-disabled": source({
        id: "source-disabled",
        sourceType: "user_submitted_document",
        permissionState: "readable",
        canUseForAnswering: false,
      }),
      "source-denied": source({
        id: "source-denied",
        sourceType: "user_submitted_document",
        permissionState: "denied",
      }),
      "source-stale": source({
        id: "source-stale",
        sourceType: "user_submitted_document",
        permissionState: "stale",
      }),
    };
    const sourceRegistry = {
      findSourceById: vi.fn(async (id: string) => {
        if (id === "source-error") {
          throw new Error("registry unavailable");
        }
        return sources[id];
      }),
    };
    const auditLog = new InMemoryAuditLog();
    const runtime = createAnswerDraftRuntime({
      env: {
        ...enabledEnv(),
        IRIS_INTERNAL_DRAFT_PERMISSION_MODE: "source-policy",
      },
      dependencies: {
        createPostgresPool: vi.fn(() => ({ query: vi.fn(), end: vi.fn(async () => undefined) })),
        createDocumentFragmentRepository: vi.fn(() => fragments),
        createDocumentSourceRegistry: vi.fn(() => sourceRegistry),
        createModelProvider: vi.fn(() => model),
        auditLog,
        createEmbeddingProfileRepository: vi.fn(() => ({
          getStaticDevelopmentProfile: vi.fn(async () => profile()),
          findOrCreateProfile: vi.fn(),
          getProfileById: vi.fn(),
        })),
      },
    });

    const result = await runtime?.answerDraftOrchestrator.generateDraft({
      question: "What can Iris use?",
      liveChatMessages: [],
    });

    const promptContext = model.generateAnswerDraft.mock.calls[0]?.[0].promptContext ?? "";
    expect(promptContext).toContain("Allowed text");
    expect(promptContext).not.toContain("Disabled text");
    expect(promptContext).not.toContain("Denied text");
    expect(promptContext).not.toContain("Stale text");
    expect(promptContext).not.toContain("Missing text");
    expect(promptContext).not.toContain("Error text");
    expect(result?.allowedFragments.map((item) => item.id)).toEqual(["fragment-allowed"]);
    expect(result?.deniedDocumentIds.sort()).toEqual([
      "source-denied",
      "source-disabled",
      "source-error",
      "source-missing",
      "source-stale",
    ]);
    expect(auditLog.events).toEqual([
      {
        type: "permission_guard_denied",
        documentId: "source-disabled",
        fragmentIds: ["fragment-disabled"],
        recordedAt: expect.any(Date),
      },
      {
        type: "permission_guard_denied",
        documentId: "source-denied",
        fragmentIds: ["fragment-denied"],
        recordedAt: expect.any(Date),
      },
      {
        type: "permission_guard_denied",
        documentId: "source-stale",
        fragmentIds: ["fragment-stale"],
        recordedAt: expect.any(Date),
      },
      {
        type: "permission_guard_denied",
        documentId: "source-missing",
        fragmentIds: ["fragment-missing"],
        recordedAt: expect.any(Date),
      },
      {
        type: "permission_guard_error",
        documentId: "source-error",
        fragmentIds: ["fragment-error"],
        message: "registry unavailable",
        recordedAt: expect.any(Date),
      },
    ]);
  });

  it("fails closed for Feishu document fragments when live permission checks are unavailable", async () => {
    const model = {
      generateAnswerDraft: vi.fn(
        async (_input: { question: string; promptContext: string }) => ({
          answerText: "Runtime draft",
        }),
      ),
    };
    const fragments = {
      searchSimilarFragments: vi.fn(async () => [
        fragment({
          id: "fragment-feishu",
          documentSourceId: "source-feishu",
          sourceUri: "https://example.feishu.cn/docx/doccnAllowed",
          text: "Feishu cached text",
        }),
      ]),
    };
    const sourceRegistry = {
      findSourceById: vi.fn(async () =>
        source({
          id: "source-feishu",
          sourceUri: "https://example.feishu.cn/docx/doccnAllowed",
          permissionState: "readable",
        }),
      ),
    };
    const runtime = createAnswerDraftRuntime({
      env: {
        ...enabledEnv(),
        IRIS_INTERNAL_DRAFT_PERMISSION_MODE: "source-policy",
      },
      dependencies: {
        createPostgresPool: vi.fn(() => ({ query: vi.fn(), end: vi.fn(async () => undefined) })),
        createDocumentFragmentRepository: vi.fn(() => fragments),
        createDocumentSourceRegistry: vi.fn(() => sourceRegistry),
        createModelProvider: vi.fn(() => model),
        createEmbeddingProfileRepository: vi.fn(() => ({
          getStaticDevelopmentProfile: vi.fn(async () => profile()),
          findOrCreateProfile: vi.fn(),
          getProfileById: vi.fn(),
        })),
      },
    });

    const result = await runtime?.answerDraftOrchestrator.generateDraft({
      question: "What can Iris use?",
      liveChatMessages: [],
    });

    const promptContext = model.generateAnswerDraft.mock.calls[0]?.[0].promptContext ?? "";
    expect(promptContext).not.toContain("Feishu cached text");
    expect(result?.allowedFragments).toEqual([]);
    expect(result?.deniedDocumentIds).toEqual(["source-feishu"]);
  });

  it("filters answer draft fragments through runtime retrieval capabilities", async () => {
    const model = {
      generateAnswerDraft: vi.fn(async (_input: GenerateAnswerDraftInput) => ({
        answerText: "Runtime draft",
      })),
    };
    const fragments = {
      searchSimilarFragments: vi.fn(async () => [
        fragment({
          id: "fragment-group",
          documentSourceId: "source-group",
          text: "Group visible document text",
        }),
        fragment({
          id: "fragment-wiki",
          documentSourceId: "source-wiki",
          text: "Knowledge base text",
        }),
        fragment({
          id: "fragment-user",
          documentSourceId: "source-user",
          text: "User submitted text",
        }),
      ]),
    };
    const sources: Record<string, DocumentSource | undefined> = {
      "source-group": source({
        id: "source-group",
        sourceType: "group_visible_document",
        permissionState: "readable",
      }),
      "source-wiki": source({
        id: "source-wiki",
        sourceType: "authorized_wiki_document",
        permissionState: "readable",
      }),
      "source-user": source({
        id: "source-user",
        sourceType: "user_submitted_document",
        permissionState: "readable",
      }),
    };
    const sourceRegistry = {
      findSourceById: vi.fn(async (id: string) => sources[id]),
    };
    const runtimeController = {
      canReadDocuments: vi.fn(() => false),
      canRetrieveKnowledgeBase: vi.fn(() => false),
    };
    const runtime = createAnswerDraftRuntime({
      env: {
        ...enabledEnv(),
        IRIS_INTERNAL_DRAFT_PERMISSION_MODE: "source-policy",
      },
      runtimeController,
      dependencies: {
        createPostgresPool: vi.fn(() => ({ query: vi.fn(), end: vi.fn(async () => undefined) })),
        createDocumentFragmentRepository: vi.fn(() => fragments),
        createDocumentSourceRegistry: vi.fn(() => sourceRegistry),
        createModelProvider: vi.fn(() => model),
        createEmbeddingProfileRepository: vi.fn(() => ({
          getStaticDevelopmentProfile: vi.fn(async () => profile()),
          findOrCreateProfile: vi.fn(),
          getProfileById: vi.fn(),
        })),
      },
    });

    const result = await runtime?.answerDraftOrchestrator.generateDraft({
      question: "What can Iris use?",
      liveChatMessages: [],
    });

    const promptContext = model.generateAnswerDraft.mock.calls[0]?.[0].promptContext ?? "";
    expect(promptContext).not.toContain("Group visible document text");
    expect(promptContext).not.toContain("Knowledge base text");
    expect(promptContext).toContain("User submitted text");
    expect(result?.allowedFragments.map((item) => item.id)).toEqual(["fragment-user"]);
    expect(result?.deniedDocumentIds.sort()).toEqual(["source-group", "source-wiki"]);
    expect(fragments.searchSimilarFragments).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceTypes: ["user_submitted_document"],
      }),
    );
    expect(runtimeController.canReadDocuments).toHaveBeenCalled();
    expect(runtimeController.canRetrieveKnowledgeBase).toHaveBeenCalled();
  });

  it("allows group-visible answer fragments only when evidence matches the current group", async () => {
    const model = {
      generateAnswerDraft: vi.fn(async (_input: GenerateAnswerDraftInput) => ({
        answerText: "Runtime draft",
      })),
    };
    const fragments = {
      searchSimilarFragments: vi.fn(async () => [
        fragment({
          id: "fragment-other-group",
          documentSourceId: "source-other-group",
          text: "Other group document text",
        }),
        fragment({
          id: "fragment-current-group",
          documentSourceId: "source-current-group",
          text: "Current group document text",
        }),
        fragment({
          id: "fragment-user",
          documentSourceId: "source-user",
          text: "User submitted text",
        }),
      ]),
    };
    const sources: Record<string, DocumentSource | undefined> = {
      "source-other-group": source({
        id: "source-other-group",
        sourceType: "group_visible_document",
        originGroupId: "chat-other",
        permissionState: "readable",
      }),
      "source-current-group": source({
        id: "source-current-group",
        sourceType: "group_visible_document",
        originGroupId: "chat-other",
        permissionState: "readable",
        evidence: [
          {
            kind: "group_message",
            sourceUri: "https://example.com/doc",
            groupId: "chat-current",
            messageId: "message-current",
            observedAt: new Date("2026-07-01T01:00:00.000Z"),
          },
        ],
      }),
      "source-user": source({
        id: "source-user",
        sourceType: "user_submitted_document",
        permissionState: "readable",
      }),
    };
    const sourceRegistry = {
      findSourceById: vi.fn(async (id: string) => sources[id]),
    };
    const runtimeController = {
      canReadDocuments: vi.fn(() => true),
      canRetrieveKnowledgeBase: vi.fn(() => true),
      canProcessGroupMessage: vi.fn(() => true),
    };
    const runtime = createAnswerDraftRuntime({
      env: {
        ...enabledEnv(),
        IRIS_INTERNAL_DRAFT_PERMISSION_MODE: "source-policy",
      },
      runtimeController,
      dependencies: {
        createPostgresPool: vi.fn(() => ({ query: vi.fn(), end: vi.fn(async () => undefined) })),
        createDocumentFragmentRepository: vi.fn(() => fragments),
        createDocumentSourceRegistry: vi.fn(() => sourceRegistry),
        createLiveChatContextProvider: vi.fn(() => ({
          loadRecentMessages: vi.fn(async () => []),
        })),
        createModelProvider: vi.fn(() => model),
        createEmbeddingProfileRepository: vi.fn(() => ({
          getStaticDevelopmentProfile: vi.fn(async () => profile()),
          findOrCreateProfile: vi.fn(),
          getProfileById: vi.fn(),
        })),
      },
    });

    const result = await runtime?.answerDraftOrchestrator.generateDraft({
      question: "What can Iris use?",
      chatId: "chat-current",
      liveChatMessages: [],
    });

    const promptContext = model.generateAnswerDraft.mock.calls[0]?.[0].promptContext ?? "";
    expect(promptContext).not.toContain("Other group document text");
    expect(promptContext).toContain("Current group document text");
    expect(promptContext).toContain("User submitted text");
    expect(result?.allowedFragments.map((item) => item.id)).toEqual([
      "fragment-current-group",
      "fragment-user",
    ]);
    expect(result?.deniedDocumentIds).toEqual(["source-other-group"]);
    expect(fragments.searchSimilarFragments).toHaveBeenCalledWith(
      expect.objectContaining({ groupId: "chat-current" }),
    );
    expect(runtimeController.canProcessGroupMessage).toHaveBeenCalledWith("chat-current");
    expect(runtimeController.canProcessGroupMessage).not.toHaveBeenCalledWith("chat-other");
  });

  it.each([
    { label: "missing", chatId: undefined },
    { label: "blank", chatId: "   " },
    { label: "oversized", chatId: "g".repeat(513) },
  ])(
    "excludes group-visible source types when source-policy group scope is $label",
    async ({ chatId }) => {
      const fragments = { searchSimilarFragments: vi.fn(async () => []) };
      const runtime = createAnswerDraftRuntime({
        env: {
          ...enabledEnv(),
          IRIS_INTERNAL_DRAFT_PERMISSION_MODE: "source-policy",
        },
        runtimeController: {
          canReadDocuments: vi.fn(() => true),
          canRetrieveKnowledgeBase: vi.fn(() => true),
          canProcessGroupMessage: vi.fn(() => true),
        },
        dependencies: {
          createPostgresPool: vi.fn(() => ({ query: vi.fn(), end: vi.fn(async () => undefined) })),
          createDocumentFragmentRepository: vi.fn(() => fragments),
          createDocumentSourceRegistry: vi.fn(() => ({ findSourceById: vi.fn() })),
          createLiveChatContextProvider: vi.fn(() => ({
            loadRecentMessages: vi.fn(async () => []),
          })),
          createModelProvider: vi.fn(() => ({
            generateAnswerDraft: vi.fn(async () => ({ answerText: "Runtime draft" })),
          })),
          createEmbeddingProfileRepository: vi.fn(() => ({
            getStaticDevelopmentProfile: vi.fn(async () => profile()),
            findOrCreateProfile: vi.fn(),
            getProfileById: vi.fn(),
          })),
        },
      });

      await runtime?.answerDraftOrchestrator.generateDraft({
        question: "What can Iris use?",
        ...(chatId === undefined ? {} : { chatId }),
        liveChatMessages: [],
      });

      expect(fragments.searchSimilarFragments).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceTypes: ["authorized_wiki_document", "user_submitted_document"],
        }),
      );
      expect(fragments.searchSimilarFragments).not.toHaveBeenCalledWith(
        expect.objectContaining({ groupId: expect.anything() }),
      );
    },
  );

  it("excludes group-visible answer fragments without source group evidence", async () => {
    const model = {
      generateAnswerDraft: vi.fn(async (_input: GenerateAnswerDraftInput) => ({
        answerText: "Runtime draft",
      })),
    };
    const fragments = {
      searchSimilarFragments: vi.fn(async () => [
        fragment({
          id: "fragment-missing-group",
          documentSourceId: "source-missing-group",
          text: "Group document without source evidence",
        }),
        fragment({
          id: "fragment-user",
          documentSourceId: "source-user",
          text: "User submitted text",
        }),
      ]),
    };
    const sources: Record<string, DocumentSource | undefined> = {
      "source-missing-group": source({
        id: "source-missing-group",
        sourceType: "group_visible_document",
        originGroupId: undefined,
        evidence: [],
        permissionState: "readable",
      }),
      "source-user": source({
        id: "source-user",
        sourceType: "user_submitted_document",
        permissionState: "readable",
      }),
    };
    const sourceRegistry = {
      findSourceById: vi.fn(async (id: string) => sources[id]),
    };
    const runtimeController = {
      canReadDocuments: vi.fn(() => true),
      canRetrieveKnowledgeBase: vi.fn(() => true),
      canProcessGroupMessage: vi.fn(() => true),
    };
    const runtime = createAnswerDraftRuntime({
      env: {
        ...enabledEnv(),
        IRIS_INTERNAL_DRAFT_PERMISSION_MODE: "source-policy",
      },
      runtimeController,
      dependencies: {
        createPostgresPool: vi.fn(() => ({ query: vi.fn(), end: vi.fn(async () => undefined) })),
        createDocumentFragmentRepository: vi.fn(() => fragments),
        createDocumentSourceRegistry: vi.fn(() => sourceRegistry),
        createLiveChatContextProvider: vi.fn(() => ({
          loadRecentMessages: vi.fn(async () => []),
        })),
        createModelProvider: vi.fn(() => model),
        createEmbeddingProfileRepository: vi.fn(() => ({
          getStaticDevelopmentProfile: vi.fn(async () => profile()),
          findOrCreateProfile: vi.fn(),
          getProfileById: vi.fn(),
        })),
      },
    });

    const result = await runtime?.answerDraftOrchestrator.generateDraft({
      question: "What can Iris use?",
      chatId: "chat-current",
      liveChatMessages: [],
    });

    const promptContext = model.generateAnswerDraft.mock.calls[0]?.[0].promptContext ?? "";
    expect(promptContext).not.toContain("Group document without source evidence");
    expect(promptContext).toContain("User submitted text");
    expect(result?.allowedFragments.map((item) => item.id)).toEqual(["fragment-user"]);
    expect(result?.deniedDocumentIds).toEqual(["source-missing-group"]);
    expect(runtimeController.canProcessGroupMessage).not.toHaveBeenCalled();
  });

  it("requires Feishu live permission guard when OpenAPI credentials are configured", async () => {
    const model = {
      generateAnswerDraft: vi.fn(async (_input: GenerateAnswerDraftInput) => ({
        answerText: "Runtime draft",
      })),
    };
    const fragments = {
      searchSimilarFragments: vi.fn(async () => [
        fragment({
          id: "fragment-live-allowed",
          documentSourceId: "source-live-allowed",
          text: "Live allowed document text",
        }),
        fragment({
          id: "fragment-live-denied",
          documentSourceId: "source-live-denied",
          text: "Live denied document text",
        }),
      ]),
    };
    const sources: Record<string, DocumentSource | undefined> = {
      "source-live-allowed": source({
        id: "source-live-allowed",
        sourceType: "authorized_wiki_document",
        sourceUri: "https://example.feishu.cn/wiki/wikcnAllowed",
        permissionState: "readable",
      }),
      "source-live-denied": source({
        id: "source-live-denied",
        sourceType: "authorized_wiki_document",
        sourceUri: "https://example.feishu.cn/wiki/wikcnDenied",
        permissionState: "readable",
      }),
    };
    const sourceRegistry = {
      findSourceById: vi.fn(async (id: string) => sources[id]),
    };
    const livePermissionChecker = {
      canReadSource: vi.fn(async (documentSource: DocumentSource) =>
        documentSource.id === "source-live-allowed",
      ),
    };
    const tokenProvider = { getTenantAccessToken: vi.fn(async () => "tenant-token") };
    const runtime = createAnswerDraftRuntime({
      env: {
        ...enabledEnv(),
        IRIS_INTERNAL_DRAFT_PERMISSION_MODE: "source-policy",
        FEISHU_APP_ID: "app-id",
        FEISHU_APP_SECRET: "app-secret",
        FEISHU_OPEN_BASE_URL: "https://open.example.com/",
        IRIS_FEISHU_DOCUMENT_FETCH_TIMEOUT_MS: "4000",
      },
      runtimeController: {
        canReadDocuments: vi.fn(() => true),
        canRetrieveKnowledgeBase: vi.fn(() => true),
      },
      dependencies: {
        createPostgresPool: vi.fn(() => ({ query: vi.fn(), end: vi.fn(async () => undefined) })),
        createDocumentFragmentRepository: vi.fn(() => fragments),
        createDocumentSourceRegistry: vi.fn(() => sourceRegistry),
        createModelProvider: vi.fn(() => model),
        createFeishuTenantAccessTokenProvider: vi.fn(() => tokenProvider),
        createFeishuDocumentPermissionChecker: vi.fn(() => livePermissionChecker),
        createEmbeddingProfileRepository: vi.fn(() => ({
          getStaticDevelopmentProfile: vi.fn(async () => profile()),
          findOrCreateProfile: vi.fn(),
          getProfileById: vi.fn(),
        })),
      },
    });

    const result = await runtime?.answerDraftOrchestrator.generateDraft({
      question: "What can Iris use?",
      liveChatMessages: [],
    });

    const promptContext = model.generateAnswerDraft.mock.calls[0]?.[0].promptContext ?? "";
    expect(promptContext).toContain("Live allowed document text");
    expect(promptContext).not.toContain("Live denied document text");
    expect(result?.allowedFragments.map((item) => item.id)).toEqual(["fragment-live-allowed"]);
    expect(result?.deniedDocumentIds).toEqual(["source-live-denied"]);
    expect(livePermissionChecker.canReadSource).toHaveBeenCalledWith(sources["source-live-allowed"]);
    expect(livePermissionChecker.canReadSource).toHaveBeenCalledWith(sources["source-live-denied"]);
  });

  it("uses configured OpenAI-compatible embedding provider when dimensions are 6", async () => {
    const embeddingProvider = { embedTexts: vi.fn(async () => [[0, 1, 0, 0, 0, 0]]) };
    const embeddingProfiles = {
      getStaticDevelopmentProfile: vi.fn(),
      findOrCreateProfile: vi.fn(async () =>
        profile({
          id: "openai-compatible:text-embedding-small:6",
          provider: "openai-compatible",
          model: "text-embedding-small",
          dimensions: 6,
          displayName: "OpenAI-compatible text-embedding-small (6d)",
        }),
      ),
      getProfileById: vi.fn(),
    };
    const fragments = { searchSimilarFragments: vi.fn(async () => []) };
    const runtime = createAnswerDraftRuntime({
      env: {
        ...enabledEnv(),
        IRIS_EMBEDDING_PROVIDER: "openai-compatible",
        IRIS_EMBEDDING_BASE_URL: "https://api.example.com/v1",
        IRIS_EMBEDDING_API_KEY: "embed-key",
        IRIS_EMBEDDING_MODEL: "text-embedding-small",
        IRIS_EMBEDDING_DIMENSIONS: "6",
      },
      dependencies: {
        createPostgresPool: vi.fn(() => ({ query: vi.fn(), end: vi.fn(async () => undefined) })),
        createDocumentFragmentRepository: vi.fn(() => fragments),
        createModelProvider: vi.fn(() => ({
          generateAnswerDraft: vi.fn(async () => ({ answerText: "Draft" })),
        })),
        createEmbeddingProfileRepository: vi.fn(() => embeddingProfiles),
        createEmbeddingProvider: vi.fn(() => embeddingProvider),
      },
    });

    await runtime?.answerDraftOrchestrator.generateDraft({
      question: "Use real embedder?",
      liveChatMessages: [],
    });

    expect(embeddingProfiles.findOrCreateProfile).toHaveBeenCalledWith({
      provider: "openai-compatible",
      model: "text-embedding-small",
      dimensions: 6,
      displayName: "OpenAI-compatible text-embedding-small (6d)",
    });
    expect(embeddingProvider.embedTexts).toHaveBeenCalledWith(["Use real embedder?"]);
    expect(fragments.searchSimilarFragments).toHaveBeenCalledWith({
      embeddingProfileId: "openai-compatible:text-embedding-small:6",
      embedding: [0, 1, 0, 0, 0, 0],
      limit: 24,
    });
  });

  it("rejects configured embedding provider without dimensions when generating a draft", async () => {
    const runtime = createAnswerDraftRuntime({
      env: {
        ...enabledEnv(),
        IRIS_EMBEDDING_PROVIDER: "openai-compatible",
        IRIS_EMBEDDING_BASE_URL: "https://api.example.com/v1",
        IRIS_EMBEDDING_API_KEY: "embed-key",
        IRIS_EMBEDDING_MODEL: "text-embedding-small",
      },
      dependencies: {
        createPostgresPool: vi.fn(() => ({ query: vi.fn(), end: vi.fn(async () => undefined) })),
        createDocumentFragmentRepository: vi.fn(() => ({ searchSimilarFragments: vi.fn(async () => []) })),
        createModelProvider: vi.fn(() => ({
          generateAnswerDraft: vi.fn(async () => ({ answerText: "Draft" })),
        })),
        createEmbeddingProfileRepository: vi.fn(() => ({
          getStaticDevelopmentProfile: vi.fn(),
          findOrCreateProfile: vi.fn(),
          getProfileById: vi.fn(),
        })),
      },
    });

    await expect(
      runtime?.answerDraftOrchestrator.generateDraft({
        question: "bad",
        liveChatMessages: [],
      }),
    ).rejects.toThrow(
      "IRIS_EMBEDDING_DIMENSIONS is required when internal answer drafts use an embedding provider",
    );
  });

  it("retries runtime embedding initialization after a transient failure", async () => {
    const embeddingProvider = { embedTexts: vi.fn(async () => [[0, 1, 0, 0, 0, 0]]) };
    const embeddingProfiles = {
      getStaticDevelopmentProfile: vi.fn(),
      findOrCreateProfile: vi
        .fn()
        .mockRejectedValueOnce(new Error("profile store unavailable"))
        .mockResolvedValueOnce(
          profile({
            id: "openai-compatible:text-embedding-small:6",
            provider: "openai-compatible",
            model: "text-embedding-small",
            dimensions: 6,
            displayName: "OpenAI-compatible text-embedding-small (6d)",
          }),
        ),
      getProfileById: vi.fn(),
    };
    const fragments = { searchSimilarFragments: vi.fn(async () => []) };
    const runtime = createAnswerDraftRuntime({
      env: {
        ...enabledEnv(),
        IRIS_EMBEDDING_PROVIDER: "openai-compatible",
        IRIS_EMBEDDING_BASE_URL: "https://api.example.com/v1",
        IRIS_EMBEDDING_API_KEY: "embed-key",
        IRIS_EMBEDDING_MODEL: "text-embedding-small",
        IRIS_EMBEDDING_DIMENSIONS: "6",
      },
      dependencies: {
        createPostgresPool: vi.fn(() => ({ query: vi.fn(), end: vi.fn(async () => undefined) })),
        createDocumentFragmentRepository: vi.fn(() => fragments),
        createModelProvider: vi.fn(() => ({
          generateAnswerDraft: vi.fn(async () => ({ answerText: "Draft" })),
        })),
        createEmbeddingProfileRepository: vi.fn(() => embeddingProfiles),
        createEmbeddingProvider: vi.fn(() => embeddingProvider),
      },
    });

    await expect(
      runtime?.answerDraftOrchestrator.generateDraft({
        question: "First attempt",
        liveChatMessages: [],
      }),
    ).rejects.toThrow("profile store unavailable");

    await expect(
      runtime?.answerDraftOrchestrator.generateDraft({
        question: "Second attempt",
        liveChatMessages: [],
      }),
    ).resolves.toMatchObject({ answerText: "Draft" });
    expect(embeddingProfiles.findOrCreateProfile).toHaveBeenCalledTimes(2);
    expect(embeddingProvider.embedTexts).toHaveBeenCalledWith(["Second attempt"]);
  });

  it("uses configured OpenAI-compatible embedding provider when dimensions are 1536", async () => {
    const vector = Array.from({ length: 1536 }, (_, index) => index / 1536);
    const embeddingProvider = { embedTexts: vi.fn(async () => [vector]) };
    const embeddingProfiles = {
      getStaticDevelopmentProfile: vi.fn(),
      findOrCreateProfile: vi.fn(async () =>
        profile({
          id: "openai-compatible:text-embedding-small:1536",
          provider: "openai-compatible",
          model: "text-embedding-small",
          dimensions: 1536,
          displayName: "OpenAI-compatible text-embedding-small (1536d)",
        }),
      ),
      getProfileById: vi.fn(async () =>
        profile({
          id: "openai-compatible:text-embedding-small:1536",
          provider: "openai-compatible",
          model: "text-embedding-small",
          dimensions: 1536,
          displayName: "OpenAI-compatible text-embedding-small (1536d)",
        }),
      ),
    };
    const fragments = { searchSimilarFragments: vi.fn(async () => []) };
    const runtime = createAnswerDraftRuntime({
      env: {
        ...enabledEnv(),
        IRIS_EMBEDDING_PROVIDER: "openai-compatible",
        IRIS_EMBEDDING_BASE_URL: "https://api.example.com/v1",
        IRIS_EMBEDDING_API_KEY: "embed-key",
        IRIS_EMBEDDING_MODEL: "text-embedding-small",
        IRIS_EMBEDDING_DIMENSIONS: "1536",
      },
      dependencies: {
        createPostgresPool: vi.fn(() => ({ query: vi.fn(), end: vi.fn(async () => undefined) })),
        createDocumentFragmentRepository: vi.fn(() => fragments),
        createModelProvider: vi.fn(() => ({
          generateAnswerDraft: vi.fn(async () => ({ answerText: "Draft" })),
        })),
        createEmbeddingProfileRepository: vi.fn(() => embeddingProfiles),
        createEmbeddingProvider: vi.fn(() => embeddingProvider),
      },
    });

    await runtime?.answerDraftOrchestrator.generateDraft({
      question: "Use production embedder?",
      liveChatMessages: [],
    });

    expect(embeddingProfiles.findOrCreateProfile).toHaveBeenCalledWith({
      provider: "openai-compatible",
      model: "text-embedding-small",
      dimensions: 1536,
      displayName: "OpenAI-compatible text-embedding-small (1536d)",
    });
    expect(fragments.searchSimilarFragments).toHaveBeenCalledWith({
      embeddingProfileId: "openai-compatible:text-embedding-small:1536",
      embedding: vector,
      limit: 24,
    });
  });

  it("rejects unsupported embedding dimensions when generating a draft", async () => {
    const runtime = createAnswerDraftRuntime({
      env: {
        ...enabledEnv(),
        IRIS_EMBEDDING_PROVIDER: "openai-compatible",
        IRIS_EMBEDDING_BASE_URL: "https://api.example.com/v1",
        IRIS_EMBEDDING_API_KEY: "embed-key",
        IRIS_EMBEDDING_MODEL: "text-embedding-large",
        IRIS_EMBEDDING_DIMENSIONS: "3072",
      },
      dependencies: {
        createPostgresPool: vi.fn(() => ({ query: vi.fn(), end: vi.fn(async () => undefined) })),
        createDocumentFragmentRepository: vi.fn(() => ({ searchSimilarFragments: vi.fn(async () => []) })),
        createModelProvider: vi.fn(() => ({
          generateAnswerDraft: vi.fn(async () => ({ answerText: "Draft" })),
        })),
        createEmbeddingProfileRepository: vi.fn(() => ({
          getStaticDevelopmentProfile: vi.fn(),
          findOrCreateProfile: vi.fn(),
          getProfileById: vi.fn(),
        })),
      },
    });

    await expect(
      runtime?.answerDraftOrchestrator.generateDraft({
        question: "bad",
        liveChatMessages: [],
      }),
    ).rejects.toThrow("Unsupported embedding dimension: 3072");
  });
});

function fragment(
  overrides: Partial<RetrievedDocumentFragment> = {},
): RetrievedDocumentFragment {
  return {
    id: "fragment-1",
    documentSourceId: "source-1",
    documentSnapshotId: "snapshot-1",
    sourceUri: "https://example.com/doc",
    chunkIndex: 0,
    text: "Indexed text",
    contentHash: "hash",
    embedding: [1, 0, 0, 0, 0, 0],
    embeddingProfileId: "static-dev-6d",
    createdAt: new Date("2026-07-02T01:00:00.000Z"),
    ...overrides,
  };
}

function profile(overrides: Partial<EmbeddingProfile> = {}): EmbeddingProfile {
  return {
    id: "static-dev-6d",
    provider: "static-dev",
    model: "static-dev-6d",
    dimensions: 6,
    displayName: "Static development embeddings (6d)",
    status: "active",
    createdAt: new Date("2026-07-02T01:00:00.000Z"),
    ...overrides,
  };
}

function source(overrides: Partial<DocumentSource> = {}): DocumentSource {
  return {
    id: "source-1",
    sourceType: "group_visible_document",
    sourceUri: "https://example.com/doc",
    permissionState: "unknown",
    syncState: "synced",
    canUseForAnswering: true,
    canUseForKnowledgeDrafts: true,
    createdAt: new Date("2026-07-01T01:00:00.000Z"),
    updatedAt: new Date("2026-07-01T01:00:00.000Z"),
    evidence: [],
    ...overrides,
  };
}

function enabledEnv() {
  return {
    IRIS_ENABLE_INTERNAL_ANSWER_DRAFTS: "true",
    IRIS_INTERNAL_DRAFT_PERMISSION_MODE: "allow-indexed",
    DATABASE_URL: "postgres://iris:iris@localhost:5432/iris",
    IRIS_MODEL_PROVIDER: "openai-compatible",
    IRIS_MODEL_BASE_URL: "https://api.example.com/v1",
    IRIS_MODEL_API_KEY: "key-a",
    IRIS_MODEL_NAME: "model-a",
  };
}
