import { createAnswerDraftOrchestrator, type AnswerDraftOrchestrator } from "../agent/answer-draft-orchestrator.js";
import {
  readAnswerDraftRuntimeConfig,
  readModelProviderConfig,
  type EnvLike,
  type ModelProviderConfig,
} from "../config/env.js";
import { readDatabaseConfig, type DatabaseConfig } from "../database/database-config.js";
import { createPostgresPool } from "../database/postgres.js";
import {
  createDocumentFragmentRepository,
  type DocumentFragmentRepository,
  type Queryable,
} from "../documents/document-fragment-repository.js";
import { createDocumentRetrievalContextBuilder } from "../memory/document-retrieval-context.js";
import { createOpenAICompatibleModelProvider } from "../model/openai-compatible-model-provider.js";

export type AnswerDraftRuntime = {
  answerDraftOrchestrator: Pick<AnswerDraftOrchestrator, "generateDraft">;
  close(): Promise<void>;
};

export type AnswerDraftRuntimeDependencies = {
  createPostgresPool?: (config: DatabaseConfig) => Queryable & { end(): Promise<void> };
  createDocumentFragmentRepository?: (dependencies: { queryable: Queryable }) => Pick<DocumentFragmentRepository, "searchSimilarFragments">;
  createModelProvider?: (config: ModelProviderConfig) => {
    generateAnswerDraft(input: { question: string; promptContext: string }): Promise<{ answerText: string }>;
  };
};

export function createAnswerDraftRuntime({
  env = process.env,
  dependencies = {},
}: {
  env?: EnvLike;
  dependencies?: AnswerDraftRuntimeDependencies;
} = {}): AnswerDraftRuntime | undefined {
  const runtimeConfig = readAnswerDraftRuntimeConfig(env);
  if (!runtimeConfig.enabled) {
    return undefined;
  }

  const modelConfig = readModelProviderConfig(env);
  if (modelConfig === undefined) {
    throw new Error("IRIS_MODEL_PROVIDER is required when internal answer drafts are enabled");
  }

  const createPool = dependencies.createPostgresPool ?? createPostgresPool;
  const createFragments = dependencies.createDocumentFragmentRepository ?? createDocumentFragmentRepository;
  const createModel =
    dependencies.createModelProvider ??
    ((config: ModelProviderConfig) => createOpenAICompatibleModelProvider({ config }));

  const pool = createPool(readDatabaseConfig(env));
  const fragments = createFragments({ queryable: pool });
  const model = createModel(modelConfig);
  const contextBuilder = createDocumentRetrievalContextBuilder({
    embedder: createStaticQueryEmbeddingProvider(),
    fragments,
    canReadDocument: async () => true,
  });
  const answerDraftOrchestrator = createAnswerDraftOrchestrator({
    contextBuilder,
    model,
  });

  return {
    answerDraftOrchestrator,
    close() {
      return pool.end();
    },
  };
}

function createStaticQueryEmbeddingProvider() {
  return {
    async embedTexts(texts: string[]): Promise<number[][]> {
      return texts.map(() => [1, 0, 0, 0, 0, 0]);
    },
  };
}
