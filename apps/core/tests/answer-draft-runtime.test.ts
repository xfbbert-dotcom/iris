import { describe, expect, it, vi } from "vitest";

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
      },
    });

    const result = await runtime?.answerDraftOrchestrator.generateDraft({
      question: "What changed?",
      liveChatMessages: [{ speaker: "Alice", text: "Please answer." }],
    });

    expect(result?.answerText).toBe("Runtime draft");
    expect(fragments.searchSimilarFragments).toHaveBeenCalledWith({
      embedding: [1, 0, 0, 0, 0, 0],
      limit: 8,
    });
    expect(model.generateAnswerDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        question: "What changed?",
      }),
    );
  });
});

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
