import { createAnswerDraftOrchestrator, type AnswerDraftOrchestrator } from "../agent/answer-draft-orchestrator.js";
import {
  readAnswerDraftRuntimeConfig,
  readEmbeddingProviderConfig,
  readModelProviderConfig,
  type EmbeddingProviderConfig,
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
import {
  createEmbeddingProfileRepository,
  type EmbeddingProfile,
  type EmbeddingProfileRepository,
} from "../documents/embedding-profile-repository.js";
import type { EmbeddingProvider } from "../documents/document-semantic-indexer.js";
import { createDocumentRetrievalContextBuilder } from "../memory/document-retrieval-context.js";
import { createOpenAICompatibleEmbeddingProvider } from "../model/openai-compatible-embedding-provider.js";
import { createOpenAICompatibleModelProvider } from "../model/openai-compatible-model-provider.js";

export type AnswerDraftRuntime = {
  answerDraftOrchestrator: Pick<AnswerDraftOrchestrator, "generateDraft">;
  close(): Promise<void>;
};

export type AnswerDraftRuntimeDependencies = {
  createPostgresPool?: (config: DatabaseConfig) => Queryable & { end(): Promise<void> };
  createDocumentFragmentRepository?: (dependencies: {
    queryable: Queryable;
    embeddingProfiles: Pick<EmbeddingProfileRepository, "getProfileById">;
  }) => Pick<DocumentFragmentRepository, "searchSimilarFragments">;
  createModelProvider?: (config: ModelProviderConfig) => {
    generateAnswerDraft(input: { question: string; promptContext: string }): Promise<{ answerText: string }>;
  };
  createEmbeddingProfileRepository?: (dependencies: { queryable: Queryable }) => Pick<
    EmbeddingProfileRepository,
    "getStaticDevelopmentProfile" | "findOrCreateProfile" | "getProfileById"
  >;
  createEmbeddingProvider?: (config: EmbeddingProviderConfig) => EmbeddingProvider;
};

type RuntimeEmbedding = {
  profile: EmbeddingProfile;
  embedder: EmbeddingProvider;
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
  const createProfiles =
    dependencies.createEmbeddingProfileRepository ?? createEmbeddingProfileRepository;
  const createEmbedding =
    dependencies.createEmbeddingProvider ??
    ((config: EmbeddingProviderConfig) => createOpenAICompatibleEmbeddingProvider({ config }));

  const pool = createPool(readDatabaseConfig(env));
  const profiles = createProfiles({ queryable: pool });
  const fragments = createFragments({ queryable: pool, embeddingProfiles: profiles });
  const model = createModel(modelConfig);
  const embeddingConfig = readEmbeddingProviderConfig(env);
  let runtimeEmbeddingPromise: Promise<RuntimeEmbedding> | undefined;
  const answerDraftOrchestrator: Pick<AnswerDraftOrchestrator, "generateDraft"> = {
    async generateDraft(input) {
      runtimeEmbeddingPromise ??= resolveRuntimeEmbedding({
        embeddingConfig,
        profiles,
        createEmbeddingProvider: createEmbedding,
      });
      const runtimeEmbedding = await runtimeEmbeddingPromise;
      const contextBuilder = createDocumentRetrievalContextBuilder({
        embeddingProfileId: runtimeEmbedding.profile.id,
        embedder: runtimeEmbedding.embedder,
        fragments,
        canReadDocument: async () => true,
      });

      return createAnswerDraftOrchestrator({
        contextBuilder,
        model,
      }).generateDraft(input);
    },
  };

  return {
    answerDraftOrchestrator,
    close() {
      return pool.end();
    },
  };
}

async function resolveRuntimeEmbedding({
  embeddingConfig,
  profiles,
  createEmbeddingProvider,
}: {
  embeddingConfig: EmbeddingProviderConfig | undefined;
  profiles: Pick<EmbeddingProfileRepository, "getStaticDevelopmentProfile" | "findOrCreateProfile">;
  createEmbeddingProvider: (config: EmbeddingProviderConfig) => EmbeddingProvider;
}): Promise<RuntimeEmbedding> {
  if (embeddingConfig === undefined) {
    return {
      profile: await profiles.getStaticDevelopmentProfile(),
      embedder: createStaticQueryEmbeddingProvider(),
    };
  }

  if (embeddingConfig.dimensions === undefined) {
    throw new Error(
      "IRIS_EMBEDDING_DIMENSIONS is required when internal answer drafts use an embedding provider",
    );
  }
  assertSupportedRuntimeEmbeddingDimension(embeddingConfig.dimensions);

  return {
    profile: await profiles.findOrCreateProfile({
      provider: "openai-compatible",
      model: embeddingConfig.model,
      dimensions: embeddingConfig.dimensions,
      displayName: `OpenAI-compatible ${embeddingConfig.model} (${embeddingConfig.dimensions}d)`,
    }),
    embedder: createEmbeddingProvider(embeddingConfig),
  };
}

function assertSupportedRuntimeEmbeddingDimension(dimension: number): void {
  if (dimension !== 6 && dimension !== 1536) {
    throw new Error(`Unsupported embedding dimension: ${dimension}`);
  }
}

function createStaticQueryEmbeddingProvider() {
  return {
    async embedTexts(texts: string[]): Promise<number[][]> {
      return texts.map(() => [1, 0, 0, 0, 0, 0]);
    },
  };
}
