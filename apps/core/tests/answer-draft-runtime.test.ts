import { describe, expect, it, vi } from "vitest";

import type { EmbeddingProfile } from "../src/documents/embedding-profile-repository.js";
import { createAnswerDraftRuntime } from "../src/runtime/answer-draft-runtime.js";

describe("createAnswerDraftRuntime", () => {
  it("returns undefined when runtime is disabled", () => {
    expect(createAnswerDraftRuntime({ env: {} })).toBeUndefined();
  });

  it("composes runtime dependencies when explicitly enabled", async () => {
    const pool = { query: vi.fn(), end: vi.fn(async () => undefined) };
    const dependencies = {
      createPostgresPool: vi.fn(() => pool),
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
      limit: 8,
    });
    expect(model.generateAnswerDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        question: "What changed?",
      }),
    );
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
      limit: 8,
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
      limit: 8,
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
