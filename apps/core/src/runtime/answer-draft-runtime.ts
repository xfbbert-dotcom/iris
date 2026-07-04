import { createAnswerDraftOrchestrator, type AnswerDraftOrchestrator } from "../agent/answer-draft-orchestrator.js";
import type { AuditLog } from "../audit/audit-log.js";
import {
  readAnswerDraftRuntimeConfig,
  readEmbeddingProviderConfig,
  readOptionalFeishuOpenApiConfig,
  readModelProviderConfig,
  type AnswerDraftPermissionMode,
  type EmbeddingProviderConfig,
  type EnvLike,
  type ModelProviderConfig,
} from "../config/env.js";
import { readDatabaseConfig, type DatabaseConfig } from "../database/database-config.js";
import { createPostgresPool } from "../database/postgres.js";
import type { ConversationMessageRepository } from "../conversation/conversation-message-repository.js";
import {
  createPostgresConversationMessageRepository,
  type Queryable as ConversationMessageQueryable,
} from "../conversation/postgres-conversation-message-repository.js";
import {
  createDocumentFragmentRepository,
  type DocumentFragmentRepository,
  type Queryable,
} from "../documents/document-fragment-repository.js";
import {
  createPostgresDocumentSourceRegistry,
  type AsyncDocumentSourceRegistry,
} from "../documents/postgres-document-source-registry.js";
import type { DocumentSource } from "../documents/document-source-registry.js";
import {
  parseFeishuDocxDocumentId,
  parseFeishuWikiNodeToken,
} from "../documents/feishu-document-body-fetcher.js";
import {
  createEmbeddingProfileRepository,
  type EmbeddingProfile,
  type EmbeddingProfileRepository,
} from "../documents/embedding-profile-repository.js";
import type { EmbeddingProvider } from "../documents/document-semantic-indexer.js";
import { createDocumentRetrievalContextBuilder } from "../memory/document-retrieval-context.js";
import {
  createFeishuDocumentPermissionChecker,
  type FeishuDocumentPermissionChecker,
  type FeishuDocumentPermissionCheckerDependencies,
} from "../permissions/feishu-document-permission-checker.js";
import {
  createFeishuTenantAccessTokenProvider,
  type FeishuTenantAccessTokenProvider,
  type FeishuTenantAccessTokenProviderDependencies,
} from "../feishu/feishu-tenant-access-token-provider.js";
import {
  createLiveChatContextProvider,
  type LiveChatContextProvider,
} from "../memory/live-chat-context-provider.js";
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
  createDocumentSourceRegistry?: (dependencies: {
    queryable: Queryable;
  }) => Pick<AsyncDocumentSourceRegistry, "findSourceById">;
  createConversationMessageRepository?: (dependencies: {
    queryable: ConversationMessageQueryable;
  }) => Pick<ConversationMessageRepository, "listRecentByChat">;
  createLiveChatContextProvider?: (dependencies: {
    repository: Pick<ConversationMessageRepository, "listRecentByChat">;
  }) => LiveChatContextProvider;
  createModelProvider?: (config: ModelProviderConfig) => {
    generateAnswerDraft(input: { question: string; promptContext: string }): Promise<{ answerText: string }>;
  };
  createEmbeddingProfileRepository?: (dependencies: { queryable: Queryable }) => Pick<
    EmbeddingProfileRepository,
    "getStaticDevelopmentProfile" | "findOrCreateProfile" | "getProfileById"
  >;
  createEmbeddingProvider?: (config: EmbeddingProviderConfig) => EmbeddingProvider;
  createFeishuTenantAccessTokenProvider?: (
    dependencies: FeishuTenantAccessTokenProviderDependencies,
  ) => FeishuTenantAccessTokenProvider;
  createFeishuDocumentPermissionChecker?: (
    dependencies: FeishuDocumentPermissionCheckerDependencies,
  ) => FeishuDocumentPermissionChecker;
  auditLog?: AuditLog;
};

type RuntimeRetrievalGate = {
  canReadDocuments(): boolean;
  canRetrieveKnowledgeBase(): boolean;
  canProcessGroupMessage?(groupId: string): boolean;
};

type RuntimeEmbedding = {
  profile: EmbeddingProfile;
  embedder: EmbeddingProvider;
};

export function createAnswerDraftRuntime({
  env = process.env,
  dependencies = {},
  runtimeController,
}: {
  env?: EnvLike;
  dependencies?: AnswerDraftRuntimeDependencies;
  runtimeController?: RuntimeRetrievalGate;
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
  const createSources =
    dependencies.createDocumentSourceRegistry ??
    (({ queryable }: { queryable: Queryable }) =>
      createPostgresDocumentSourceRegistry(
        queryable as Parameters<typeof createPostgresDocumentSourceRegistry>[0],
      ));
  const createConversationMessages =
    dependencies.createConversationMessageRepository ?? createPostgresConversationMessageRepository;
  const createLiveChatContext =
    dependencies.createLiveChatContextProvider ?? createLiveChatContextProvider;
  const createModel =
    dependencies.createModelProvider ??
    ((config: ModelProviderConfig) => createOpenAICompatibleModelProvider({ config }));
  const createProfiles =
    dependencies.createEmbeddingProfileRepository ?? createEmbeddingProfileRepository;
  const createEmbedding =
    dependencies.createEmbeddingProvider ??
    ((config: EmbeddingProviderConfig) => createOpenAICompatibleEmbeddingProvider({ config }));
  const createTokenProvider =
    dependencies.createFeishuTenantAccessTokenProvider ?? createFeishuTenantAccessTokenProvider;
  const createLivePermissionChecker =
    dependencies.createFeishuDocumentPermissionChecker ?? createFeishuDocumentPermissionChecker;

  const pool = createPool(readDatabaseConfig(env));
  const profiles = createProfiles({ queryable: pool });
  const fragments = createFragments({ queryable: pool, embeddingProfiles: profiles });
  const sourceRegistry =
    runtimeConfig.permissionMode === "source-policy"
      ? createSources({ queryable: pool })
      : undefined;
  const livePermissionChecker =
    runtimeConfig.permissionMode === "source-policy"
      ? createOptionalLivePermissionChecker({
          env,
          createTokenProvider,
          createLivePermissionChecker,
        })
      : undefined;
  const conversationMessages = createConversationMessages({ queryable: pool });
  const liveChatContextProvider = createLiveChatContext({ repository: conversationMessages });
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
        canReadDocument: createCanReadDocument({
          permissionMode: runtimeConfig.permissionMode,
          sourceRegistry,
          runtimeController,
          livePermissionChecker,
        }),
        auditLog: dependencies.auditLog,
      });

      return createAnswerDraftOrchestrator({
        contextBuilder,
        model,
        liveChatContextProvider,
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

function createCanReadDocument({
  permissionMode,
  sourceRegistry,
  runtimeController,
  livePermissionChecker,
}: {
  permissionMode: AnswerDraftPermissionMode;
  sourceRegistry?: Pick<AsyncDocumentSourceRegistry, "findSourceById">;
  runtimeController?: RuntimeRetrievalGate;
  livePermissionChecker?: Pick<FeishuDocumentPermissionChecker, "canReadSource">;
}): (documentSourceId: string) => Promise<boolean> {
  if (permissionMode === "allow-indexed") {
    return async () => true;
  }

  return (documentSourceId) =>
    canReadBySourcePolicy(
      documentSourceId,
      sourceRegistry,
      runtimeController,
      livePermissionChecker,
    );
}

async function canReadBySourcePolicy(
  documentSourceId: string,
  sourceRegistry: Pick<AsyncDocumentSourceRegistry, "findSourceById"> | undefined,
  runtimeController: RuntimeRetrievalGate | undefined,
  livePermissionChecker: Pick<FeishuDocumentPermissionChecker, "canReadSource"> | undefined,
): Promise<boolean> {
  if (sourceRegistry === undefined) {
    return false;
  }

  let source: DocumentSource | undefined;
  try {
    source = await sourceRegistry.findSourceById(documentSourceId);
  } catch {
    return false;
  }
  if (source === undefined) {
    return false;
  }

  const locallyAllowed =
    source.canUseForAnswering &&
    (source.permissionState === "unknown" || source.permissionState === "readable") &&
    canUseSourceByRuntimeCapabilities(source, runtimeController);
  if (!locallyAllowed) {
    return false;
  }
  if (!requiresFeishuLivePermission(source)) {
    return true;
  }
  if (livePermissionChecker === undefined) {
    return false;
  }

  return livePermissionChecker.canReadSource(source);
}

function requiresFeishuLivePermission(source: DocumentSource): boolean {
  return (
    parseFeishuDocxDocumentId(source.sourceUri) !== undefined ||
    parseFeishuWikiNodeToken(source.sourceUri) !== undefined
  );
}

function createOptionalLivePermissionChecker({
  env,
  createTokenProvider,
  createLivePermissionChecker,
}: {
  env: EnvLike;
  createTokenProvider: (
    dependencies: FeishuTenantAccessTokenProviderDependencies,
  ) => FeishuTenantAccessTokenProvider;
  createLivePermissionChecker: (
    dependencies: FeishuDocumentPermissionCheckerDependencies,
  ) => FeishuDocumentPermissionChecker;
}): FeishuDocumentPermissionChecker | undefined {
  const feishuConfig = readOptionalFeishuOpenApiConfig(env);
  if (feishuConfig === undefined) {
    return undefined;
  }

  const tokenProvider = createTokenProvider({
    baseUrl: feishuConfig.baseUrl,
    appId: feishuConfig.appId,
    appSecret: feishuConfig.appSecret,
    timeoutMs: feishuConfig.documentFetchTimeoutMs,
  });

  return createLivePermissionChecker({
    baseUrl: feishuConfig.baseUrl,
    tokenProvider,
    timeoutMs: feishuConfig.documentFetchTimeoutMs,
  });
}

function canUseSourceByRuntimeCapabilities(
  source: DocumentSource,
  runtimeController: RuntimeRetrievalGate | undefined,
): boolean {
  if (runtimeController === undefined) {
    return true;
  }
  if (source.sourceType === "group_visible_document") {
    return canUseGroupVisibleSource(source, runtimeController);
  }
  if (source.sourceType === "authorized_wiki_document") {
    return runtimeController.canRetrieveKnowledgeBase();
  }

  return true;
}

function canUseGroupVisibleSource(source: DocumentSource, runtimeController: RuntimeRetrievalGate): boolean {
  if (!runtimeController.canReadDocuments()) {
    return false;
  }

  if (runtimeController.canProcessGroupMessage === undefined) {
    return true;
  }

  const sourceGroupIds = collectSourceGroupIds(source);
  if (sourceGroupIds.length === 0) {
    return false;
  }

  return sourceGroupIds.some((groupId) => runtimeController.canProcessGroupMessage?.(groupId) === true);
}

function collectSourceGroupIds(source: DocumentSource): string[] {
  const groupIds = new Set<string>();
  addGroupId(groupIds, source.originGroupId);
  for (const evidence of source.evidence) {
    addGroupId(groupIds, evidence.groupId);
  }

  return [...groupIds];
}

function addGroupId(groupIds: Set<string>, groupId: string | undefined): void {
  const normalized = groupId?.trim();
  if (normalized !== undefined && normalized.length > 0) {
    groupIds.add(normalized);
  }
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
