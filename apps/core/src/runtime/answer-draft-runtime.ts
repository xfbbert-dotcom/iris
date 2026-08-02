import { createHash } from "node:crypto";

import {
  createAnswerDraftOrchestrator,
  resolveAnswerDraftExecutionId,
  type AnswerDraftOrchestrator,
} from "../agent/answer-draft-orchestrator.js";
import type { AgentExecutionObserver } from "../agent-runtime/agent-execution-observer.js";
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
import type { DocumentSource, DocumentSourceType } from "../documents/document-source-registry.js";
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
import type { PermissionGuardDecision } from "../permissions/permission-guard.js";
import {
  createFeishuTenantAccessTokenProvider,
  type FeishuTenantAccessTokenProvider,
  type FeishuTenantAccessTokenProviderDependencies,
} from "../feishu/feishu-tenant-access-token-provider.js";
import {
  createLiveChatContextProvider,
  type LiveChatContextProvider,
} from "../memory/live-chat-context-provider.js";
import { assertSupportedRuntimeEmbeddingDimension } from "../model/embedding-profile-id.js";
import { createQueryEmbeddingProvider } from "../model/embedding-input-format.js";
import { createOpenAICompatibleEmbeddingProvider } from "../model/openai-compatible-embedding-provider.js";
import { createOpenAICompatibleModelProvider } from "../model/openai-compatible-model-provider.js";
import type { GroupMemoryRepository } from "../memory/group-memory-repository.js";
import {
  createAnswerSourcePermissionVerifier,
  createUnavailableAnswerSourcePermissionVerifier,
  type AnswerSourcePermissionVerifier,
} from "../answer-replies/answer-source-permission-verifier.js";
import {
  createPostgresGroupMemoryRepository,
  type PostgresGroupMemoryDataSource,
} from "../memory/postgres-group-memory-repository.js";
import {
  createGroupMemoryService,
  type GroupMemoryService,
} from "../memory/group-memory-service.js";
import {
  createGroupMemoryContextProvider,
  type GroupMemoryContextProvider,
} from "../memory/group-memory-context-provider.js";
import {
  createConversationStateContextProvider,
  type ConversationStateContextProvider,
} from "../conversation-state/conversation-state-context-provider.js";
import type { PostgresConversationStateDataSource } from "../conversation-state/postgres-conversation-state-repository.js";
import {
  createChatKnowledgeDraftGenerator,
  type ChatKnowledgeDraftGenerator,
} from "../knowledge-governance/chat-knowledge-draft-generator.js";

export type AnswerDraftRuntime = {
  answerDraftOrchestrator: Pick<AnswerDraftOrchestrator, "generateDraft">;
  answerSourcePermissionVerifier: AnswerSourcePermissionVerifier;
  chatKnowledgeDraftGenerator?: ChatKnowledgeDraftGenerator;
  groupMemoryService?: GroupMemoryService;
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
  createGroupMemoryRepository?: (dependencies: {
    dataSource: PostgresGroupMemoryDataSource;
  }) => GroupMemoryRepository;
  createGroupMemoryService?: (dependencies: {
    repository: GroupMemoryRepository;
    auditLog?: AuditLog;
  }) => GroupMemoryService;
  createConversationStateContextProvider?: (dependencies: {
    dataSource: PostgresConversationStateDataSource;
  }) => ConversationStateContextProvider;
  auditLog?: AuditLog;
};

type RuntimeRetrievalGate = {
  canReadDocuments(): boolean;
  canRetrieveKnowledgeBase(): boolean;
  canReadGroupContext?(groupId: string): boolean;
  canProcessGroupMessage?(groupId: string): boolean;
};

type RuntimeEmbedding = {
  profile: EmbeddingProfile;
  embedder: EmbeddingProvider;
};

const MAX_CURRENT_GROUP_ID_CHARS = 512;

export function createAnswerDraftRuntime({
  env = process.env,
  dependencies = {},
  runtimeController,
  agentExecutionObserver,
}: {
  env?: EnvLike;
  dependencies?: AnswerDraftRuntimeDependencies;
  runtimeController?: RuntimeRetrievalGate;
  agentExecutionObserver?: AgentExecutionObserver;
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
  const createMemories =
    dependencies.createGroupMemoryRepository ?? createPostgresGroupMemoryRepository;
  const createMemoryService =
    dependencies.createGroupMemoryService ?? createGroupMemoryService;
  const createConversationState =
    dependencies.createConversationStateContextProvider ?? createConversationStateContextProvider;

  const livePermissionChecker =
    runtimeConfig.permissionMode === "source-policy"
      ? createOptionalLivePermissionChecker({
          env,
          createTokenProvider,
          createLivePermissionChecker,
        })
      : undefined;
  const pool = createPool(readDatabaseConfig(env));
  const groupMemoryRepository = isPostgresGroupMemoryDataSource(pool)
    ? createMemories({ dataSource: pool })
    : undefined;
  const groupMemoryService = groupMemoryRepository === undefined
    ? undefined
    : createMemoryService({
        repository: groupMemoryRepository,
        ...(dependencies.auditLog === undefined ? {} : { auditLog: dependencies.auditLog }),
      });
  const conversationStateContextProvider = isPostgresConversationStateDataSource(pool)
    ? createRuntimeGatedConversationStateContextProvider({
        delegate: createConversationState({ dataSource: pool }),
        runtimeController,
      })
    : undefined;
  const profiles = createProfiles({ queryable: pool });
  const fragments = createFragments({ queryable: pool, embeddingProfiles: profiles });
  const sourceRegistry =
    runtimeConfig.permissionMode === "source-policy"
      ? createSources({ queryable: pool })
      : undefined;
  const conversationMessages = createConversationMessages({ queryable: pool });
  const liveChatContextProvider = createRuntimeGatedLiveChatContextProvider({
    delegate: createLiveChatContext({ repository: conversationMessages }),
    runtimeController,
  });
  const model = createModel(modelConfig);
  const embeddingConfig = readEmbeddingProviderConfig(env);
  let runtimeEmbeddingPromise: Promise<RuntimeEmbedding> | undefined;
  const answerDraftOrchestrator: Pick<AnswerDraftOrchestrator, "generateDraft"> = {
    async generateDraft(input) {
      const executionId = resolveAnswerDraftExecutionId(input.executionId);
      const currentGroupId = normalizeCurrentGroupId(input.chatId);
      const documentGroupId = runtimeConfig.permissionMode === "source-policy"
        ? currentGroupId
        : undefined;
      const onPermissionDecision = createPermissionDecisionObservationHandler({
        observer: agentExecutionObserver,
        executionId,
        groupId: currentGroupId,
        actorOpenId: normalizeOptionalRuntimeReference(input.askerId),
      });
      const contextBuilder = {
        async buildContext(
          contextInput: Parameters<
            ReturnType<typeof createDocumentRetrievalContextBuilder>["buildContext"]
          >[0],
        ) {
          runtimeEmbeddingPromise ??= resolveRuntimeEmbedding({
            embeddingConfig,
            profiles,
            createEmbeddingProvider: createEmbedding,
          }).catch((error: unknown) => {
            runtimeEmbeddingPromise = undefined;
            throw error;
          });
          const runtimeEmbedding = await runtimeEmbeddingPromise;
          return createDocumentRetrievalContextBuilder({
            embeddingProfileId: runtimeEmbedding.profile.id,
            embedder: runtimeEmbedding.embedder,
            fragments,
            sourceTypes: selectAnswerSourceTypes({
              permissionMode: runtimeConfig.permissionMode,
              runtimeController,
              currentGroupId: documentGroupId,
            }),
            ...(documentGroupId === undefined ? {} : { groupId: documentGroupId }),
            ...(currentGroupId === undefined ? {} : { memoryGroupId: currentGroupId }),
            ...(groupMemoryRepository === undefined
              ? {}
              : {
                  groupMemoryContextProvider: createRuntimeGatedGroupMemoryContextProvider({
                    delegate: createGroupMemoryContextProvider({
                      repository: groupMemoryRepository,
                    }),
                    runtimeController,
                  }),
                }),
            ...(currentGroupId === undefined || conversationStateContextProvider === undefined
              ? {}
              : {
                  conversationStateGroupId: currentGroupId,
                  conversationStateContextProvider,
                }),
            canReadDocument: createCanReadDocument({
              permissionMode: runtimeConfig.permissionMode,
              sourceRegistry,
              runtimeController,
              livePermissionChecker,
              currentGroupId: documentGroupId,
            }),
            ...(onPermissionDecision === undefined ? {} : { onPermissionDecision }),
            auditLog: dependencies.auditLog,
          }).buildContext(contextInput);
        },
      };

      return createAnswerDraftOrchestrator({
        contextBuilder,
        model,
        liveChatContextProvider,
        agentExecutionObserver,
        provider: modelConfig.provider,
        modelId: modelConfig.model,
      }).generateDraft({
        ...input,
        executionId,
      });
    },
  };

  const answerSourcePermissionVerifier = runtimeConfig.permissionMode === "source-policy"
    ? createAnswerSourcePermissionVerifier({
        canReadDocument: createCanReadDocument({
          permissionMode: runtimeConfig.permissionMode,
          sourceRegistry,
          runtimeController,
          livePermissionChecker,
        }),
      })
    : createUnavailableAnswerSourcePermissionVerifier();

  return {
    answerDraftOrchestrator,
    answerSourcePermissionVerifier,
    chatKnowledgeDraftGenerator: createChatKnowledgeDraftGenerator({
      repository: conversationMessages,
      model,
      canReadGroupContext: (groupId) => (
        runtimeController?.canReadGroupContext?.(groupId) === true
      ),
    }),
    ...(groupMemoryService === undefined ? {} : { groupMemoryService }),
    close() {
      return pool.end();
    },
  };
}

function createPermissionDecisionObservationHandler({
  observer,
  executionId,
  groupId,
  actorOpenId,
}: {
  observer: AgentExecutionObserver | undefined;
  executionId: string;
  groupId: string | undefined;
  actorOpenId: string | undefined;
}): ((decision: PermissionGuardDecision) => Promise<void>) | undefined {
  if (observer === undefined) {
    return undefined;
  }

  return async (decision) => {
    const event = permissionDecisionEvent(decision.outcome);
    await observer.observe({
      ...(groupId === undefined ? {} : { groupId }),
      ...(actorOpenId === undefined ? {} : { actorOpenId }),
      subjectType: "permission_decision",
      subjectId: decision.documentId,
      eventType: event.eventType,
      phase: "context_assembly",
      outcome: event.outcome,
      decisionReason: event.decisionReason,
      operationKey: createPermissionDecisionOperationKey(
        executionId,
        decision.documentId,
        decision.outcome,
      ),
      metadata: { turnId: executionId },
    });
  };
}

function permissionDecisionEvent(outcome: PermissionGuardDecision["outcome"]): {
  eventType: "permission_allowed" | "permission_denied" | "permission_error";
  outcome: "success" | "denied" | "error";
  decisionReason: string;
} {
  if (outcome === "allowed") {
    return {
      eventType: "permission_allowed",
      outcome: "success",
      decisionReason: "live_permission_allowed",
    };
  }
  if (outcome === "denied") {
    return {
      eventType: "permission_denied",
      outcome: "denied",
      decisionReason: "live_permission_denied",
    };
  }
  return {
    eventType: "permission_error",
    outcome: "error",
    decisionReason: "live_permission_error",
  };
}

function createPermissionDecisionOperationKey(
  executionId: string,
  documentId: string,
  outcome: PermissionGuardDecision["outcome"],
): string {
  return [
    "turn",
    sha256(executionId),
    "permission",
    sha256(documentId),
    outcome,
  ].join(":");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeOptionalRuntimeReference(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  if (normalized === undefined || normalized.length === 0 || [...normalized].length > 512) {
    return undefined;
  }
  return normalized;
}

function isPostgresGroupMemoryDataSource(
  value: Queryable,
): value is Queryable & PostgresGroupMemoryDataSource {
  return "connect" in value && typeof value.connect === "function";
}

function isPostgresConversationStateDataSource(
  value: Queryable,
): value is Queryable & PostgresConversationStateDataSource {
  return "connect" in value && typeof value.connect === "function";
}

function createRuntimeGatedConversationStateContextProvider({
  delegate,
  runtimeController,
}: {
  delegate: ConversationStateContextProvider;
  runtimeController?: RuntimeRetrievalGate;
}): ConversationStateContextProvider {
  return {
    async loadRelevant(input) {
      if (runtimeController?.canReadGroupContext?.(input.groupId) !== true) {
        return { threads: [], actions: [] };
      }
      return delegate.loadRelevant(input);
    },
  };
}

function createRuntimeGatedGroupMemoryContextProvider({
  delegate,
  runtimeController,
}: {
  delegate: GroupMemoryContextProvider;
  runtimeController?: RuntimeRetrievalGate;
}): GroupMemoryContextProvider {
  return {
    async loadActiveMemories(input) {
      if (
        runtimeController?.canReadGroupContext !== undefined &&
        !runtimeController.canReadGroupContext(input.groupId)
      ) {
        return [];
      }
      if (
        runtimeController?.canProcessGroupMessage !== undefined &&
        !runtimeController.canProcessGroupMessage(input.groupId)
      ) {
        return [];
      }
      return delegate.loadActiveMemories(input);
    },
  };
}

function createRuntimeGatedLiveChatContextProvider({
  delegate,
  runtimeController,
}: {
  delegate: LiveChatContextProvider;
  runtimeController?: RuntimeRetrievalGate;
}): LiveChatContextProvider {
  return {
    async loadRecentMessages(input) {
      if (
        runtimeController?.canReadGroupContext !== undefined &&
        !runtimeController.canReadGroupContext(input.chatId)
      ) {
        return [];
      }

      return delegate.loadRecentMessages(input);
    },
  };
}

function createCanReadDocument({
  permissionMode,
  sourceRegistry,
  runtimeController,
  livePermissionChecker,
  currentGroupId,
}: {
  permissionMode: AnswerDraftPermissionMode;
  sourceRegistry?: Pick<AsyncDocumentSourceRegistry, "findSourceById">;
  runtimeController?: RuntimeRetrievalGate;
  livePermissionChecker?: Pick<FeishuDocumentPermissionChecker, "canReadSource">;
  currentGroupId?: string;
}): (documentSourceId: string, chatId?: string) => Promise<boolean> {
  if (permissionMode === "allow-indexed") {
    return async () => true;
  }

  return (documentSourceId, chatId = currentGroupId) =>
    canReadBySourcePolicy(
      documentSourceId,
      sourceRegistry,
      runtimeController,
      livePermissionChecker,
      normalizeCurrentGroupId(chatId),
    );
}

async function canReadBySourcePolicy(
  documentSourceId: string,
  sourceRegistry: Pick<AsyncDocumentSourceRegistry, "findSourceById"> | undefined,
  runtimeController: RuntimeRetrievalGate | undefined,
  livePermissionChecker: Pick<FeishuDocumentPermissionChecker, "canReadSource"> | undefined,
  currentGroupId: string | undefined,
): Promise<boolean> {
  if (sourceRegistry === undefined) {
    return false;
  }

  const source = await sourceRegistry.findSourceById(documentSourceId);
  if (source === undefined) {
    return false;
  }

  const locallyAllowed =
    source.canUseForAnswering &&
    (source.permissionState === "unknown" || source.permissionState === "readable") &&
    canUseSourceByRuntimeCapabilities(source, runtimeController, currentGroupId);
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
  currentGroupId: string | undefined,
): boolean {
  if (source.sourceType === "group_visible_document") {
    return canUseGroupVisibleSource(source, runtimeController, currentGroupId);
  }
  if (source.sourceType === "authorized_wiki_document") {
    return runtimeController?.canRetrieveKnowledgeBase() ?? true;
  }

  return true;
}

function selectAnswerSourceTypes({
  permissionMode,
  runtimeController,
  currentGroupId,
}: {
  permissionMode: AnswerDraftPermissionMode;
  runtimeController: RuntimeRetrievalGate | undefined;
  currentGroupId: string | undefined;
}): DocumentSourceType[] | undefined {
  if (runtimeController === undefined && permissionMode === "allow-indexed") {
    return undefined;
  }

  const sourceTypes: DocumentSourceType[] = [];
  const canReadDocuments = runtimeController?.canReadDocuments() ?? true;
  if (
    canReadDocuments &&
    (permissionMode === "allow-indexed" || currentGroupId !== undefined)
  ) {
    sourceTypes.push("group_visible_document");
  }
  if (runtimeController?.canRetrieveKnowledgeBase() ?? true) {
    sourceTypes.push("authorized_wiki_document");
  }
  sourceTypes.push("user_submitted_document");

  return sourceTypes;
}

function canUseGroupVisibleSource(
  source: DocumentSource,
  runtimeController: RuntimeRetrievalGate | undefined,
  currentGroupId: string | undefined,
): boolean {
  if (currentGroupId === undefined) {
    return false;
  }
  if (runtimeController !== undefined && !runtimeController.canReadDocuments()) {
    return false;
  }

  const sourceGroupIds = collectSourceGroupIds(source);
  if (!sourceGroupIds.includes(currentGroupId)) {
    return false;
  }

  return runtimeController?.canProcessGroupMessage?.(currentGroupId) ?? true;
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

function normalizeCurrentGroupId(groupId: string | undefined): string | undefined {
  const normalized = groupId?.trim();
  if (
    normalized === undefined ||
    normalized.length === 0 ||
    normalized.length > MAX_CURRENT_GROUP_ID_CHARS
  ) {
    return undefined;
  }

  return normalized;
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
    embedder: createQueryEmbeddingProvider({
      model: embeddingConfig.model,
      delegate: createEmbeddingProvider(embeddingConfig),
    }),
  };
}

function createStaticQueryEmbeddingProvider() {
  return {
    async embedTexts(texts: string[]): Promise<number[][]> {
      return texts.map(() => [1, 0, 0, 0, 0, 0]);
    },
  };
}
