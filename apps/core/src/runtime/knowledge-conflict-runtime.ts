import type pg from "pg";

import type { RuntimeController } from "../admin/runtime-controller.js";
import { createPostgresActionProposalRepository } from
  "../action-approvals/postgres-action-proposal-repository.js";
import { createPostgresManagedKnowledgePageRepository } from
  "../action-approvals/postgres-managed-knowledge-page-repository.js";
import {
  readEmbeddingProviderConfig,
  readFeishuOpenApiConfig,
  readKnowledgeConflictRuntimeConfig,
  readModelProviderConfig,
  type EnvLike,
  type KnowledgeConflictRuntimeConfig,
} from "../config/env.js";
import { createPostgresConversationMessageRepository } from
  "../conversation/postgres-conversation-message-repository.js";
import type { DatabaseConfig } from "../database/database-config.js";
import { createPostgresPool } from "../database/postgres.js";
import { createDocumentFragmentRepository } from
  "../documents/document-fragment-repository.js";
import { createDocumentSnapshotRepository } from
  "../documents/document-snapshot-repository.js";
import { createEmbeddingProfileRepository } from
  "../documents/embedding-profile-repository.js";
import { createPostgresDocumentSourceRegistry } from
  "../documents/postgres-document-source-registry.js";
import { createFeishuBotChatAccessChecker } from
  "../feishu/feishu-bot-chat-access-checker.js";
import { createFeishuGroupMembershipChecker } from
  "../feishu/feishu-group-membership-checker.js";
import { createFeishuInteractiveCardClient } from
  "../feishu/feishu-interactive-card-client.js";
import { createFeishuTenantAccessTokenProvider } from
  "../feishu/feishu-tenant-access-token-provider.js";
import { createPostgresKnowledgeDraftRepository } from
  "../knowledge-governance/postgres-knowledge-draft-repository.js";
import type { KnowledgeDraftPresentationRuntime } from
  "../knowledge-cards/knowledge-draft-presentation-service.js";
import {
  createKnowledgeConflictAnswerProvider,
  type KnowledgeConflictAnswerProvider,
} from "../knowledge-conflicts/knowledge-conflict-answer-provider.js";
import { createKnowledgeConflictCurrentValidator } from
  "../knowledge-conflicts/knowledge-conflict-current-validator.js";
import type { KnowledgeConflictCurrentValidator } from
  "../knowledge-conflicts/knowledge-conflict-current-validator.js";
import { createKnowledgeConflictDispatcher } from
  "../knowledge-conflicts/knowledge-conflict-dispatcher.js";
import {
  createKnowledgeConflictDispatcherLoop,
  type KnowledgeConflictDispatcherLoopSnapshot,
} from "../knowledge-conflicts/knowledge-conflict-dispatcher-loop.js";
import { createKnowledgeConflictEvidenceBuilder } from
  "../knowledge-conflicts/knowledge-conflict-evidence-builder.js";
import {
  createKnowledgeConflictInteractionWorker,
} from "../knowledge-conflicts/knowledge-conflict-interaction-worker.js";
import { createOpenAICompatibleKnowledgeConflictDetector } from
  "../knowledge-conflicts/openai-compatible-knowledge-conflict-detector.js";
import type {
  KnowledgeConflictCandidateStatusCounts,
  KnowledgeConflictDeliveryStatusCounts,
  KnowledgeConflictInteractionResultCounts,
  KnowledgeConflictRepository,
  KnowledgeConflictScanStatusCounts,
} from "../knowledge-conflicts/knowledge-conflict-repository.js";
import {
  createPostgresKnowledgeConflictRepository,
  type PostgresKnowledgeConflictDataSource,
} from "../knowledge-conflicts/postgres-knowledge-conflict-repository.js";
import { createKnowledgeConflictScanner } from
  "../knowledge-conflicts/knowledge-conflict-scanner.js";
import {
  createKnowledgeConflictScannerLoop,
  type KnowledgeConflictScannerLoop,
  type KnowledgeConflictScannerLoopSnapshot,
} from "../knowledge-conflicts/knowledge-conflict-scanner-loop.js";
import { createOpenAICompatibleChatCompletionsClient } from
  "../model/openai-compatible-chat-completions-client.js";
import { createQueryEmbeddingProvider } from "../model/embedding-input-format.js";
import { createEmbeddingProfileId } from "../model/embedding-profile-id.js";
import { createOpenAICompatibleEmbeddingProvider } from
  "../model/openai-compatible-embedding-provider.js";
import { createFeishuDocumentPermissionChecker } from
  "../permissions/feishu-document-permission-checker.js";
import { closeRuntimeResources } from "./runtime-close.js";
import { observeStartupPromise } from "./startup-promise.js";

const SCANNER_WORKER_ID = "knowledge-conflict-scanner";
const DISPATCHER_WORKER_ID = "knowledge-conflict-dispatcher";
const DETECTOR_CONTRACT_VERSION = "knowledge-conflict-v1";
const REQUIRED_MIGRATIONS = {
  migration0046Applied: "0046_knowledge_conflict_candidates.sql",
  migration0047Applied: "0047_knowledge_conflict_callback_identities.sql",
  migration0048Applied: "0048_knowledge_conflict_draft_reattestations.sql",
} as const;

type KnowledgeConflictRuntimeGate = Pick<RuntimeController,
  | "canProcessGroupMessage"
  | "canReadDocuments"
  | "canRetrieveKnowledgeBase"
  | "canGenerateKnowledgeDrafts"
  | "canProactivelySpeak"
>;

export type KnowledgeConflictInteractionDelegate = {
  processInteraction: ReturnType<typeof createKnowledgeConflictInteractionWorker>["processInteraction"];
};

export type KnowledgeConflictRuntimeStatus = {
  enabled: true;
  running: boolean;
  migration0046Applied: boolean;
  migration0047Applied: boolean;
  migration0048Applied: boolean;
  enabledGroupCount: number;
  scanner: KnowledgeConflictScannerLoopSnapshot;
  dispatcher: KnowledgeConflictDispatcherLoopSnapshot;
  scans: KnowledgeConflictScanStatusCounts;
  candidates: KnowledgeConflictCandidateStatusCounts;
  deliveries: KnowledgeConflictDeliveryStatusCounts;
  interactions: KnowledgeConflictInteractionResultCounts;
  reconciliation: {
    terminalFailed: number;
    outcomeUnknown: number;
  };
};

export type KnowledgeConflictRuntime = {
  repository: KnowledgeConflictRepository;
  currentValidator: KnowledgeConflictCurrentValidator;
  answerProvider: KnowledgeConflictAnswerProvider;
  interactionWorker: KnowledgeConflictInteractionDelegate;
  canUseKnowledgeConflict(groupId: string): boolean;
  start(): Promise<void>;
  getStatus(): Promise<KnowledgeConflictRuntimeStatus>;
  close(): Promise<void>;
};

type DispatcherLoop = ReturnType<typeof createKnowledgeConflictDispatcherLoop>;

export type KnowledgeConflictRuntimeComposition = {
  repository: KnowledgeConflictRepository;
  currentValidator: KnowledgeConflictCurrentValidator;
  answerProvider: KnowledgeConflictAnswerProvider;
  interactionWorker: KnowledgeConflictInteractionDelegate;
  scannerLoop: KnowledgeConflictScannerLoop;
  dispatcherLoop: DispatcherLoop;
  prepare(): Promise<void>;
  getRequiredMigrationStatus(): Promise<KnowledgeConflictMigrationStatus>;
  canUseForEvidence(groupId: string): boolean;
  canUseForAnswer(groupId: string): boolean;
};

export type KnowledgeConflictRuntimeCompositionInput = {
  pool: KnowledgeConflictPool;
  env: EnvLike;
  config: Extract<KnowledgeConflictRuntimeConfig, { enabled: true }>;
  canUseForDelivery(groupId: string): boolean;
  canUseForEvidence(groupId: string): boolean;
  canUseForAnswer(groupId: string): boolean;
  getKnowledgeCardPresentationRuntime(): KnowledgeDraftPresentationRuntime | undefined;
};

type KnowledgeConflictPool = PostgresKnowledgeConflictDataSource & {
  end(): Promise<void>;
};

type KnowledgeConflictMigrationStatus = Pick<
  KnowledgeConflictRuntimeStatus,
  "migration0046Applied" | "migration0047Applied" | "migration0048Applied"
>;

export type KnowledgeConflictRuntimeDependencies = {
  createPostgresPool?: (config: DatabaseConfig) => KnowledgeConflictPool;
  createComposition?: (
    input: KnowledgeConflictRuntimeCompositionInput,
  ) => KnowledgeConflictRuntimeComposition;
  onStartupCleanup?: (cleanup: Promise<void>) => void;
};

export function createKnowledgeConflictRuntime({
  env = process.env,
  runtimeController,
  getKnowledgeCardPresentationRuntime,
  dependencies = {},
}: {
  env?: EnvLike;
  runtimeController?: KnowledgeConflictRuntimeGate;
  getKnowledgeCardPresentationRuntime(): KnowledgeDraftPresentationRuntime | undefined;
  dependencies?: KnowledgeConflictRuntimeDependencies;
}): KnowledgeConflictRuntime | undefined {
  const config = readKnowledgeConflictRuntimeConfig(env);
  if (!config.enabled) return undefined;
  if (runtimeController === undefined) {
    throw new Error("runtimeController is required when knowledge conflicts are enabled");
  }

  const enabledGroups = new Set(config.enabledGroupIds);
  let lifecycle: "idle" | "starting" | "started" | "failed" | "closed" = "idle";
  const hasBaseGate = (groupId: string): boolean => {
    if (lifecycle !== "started") return false;
    const normalized = normalizeGroupId(groupId);
    return normalized !== undefined && enabledGroups.has(normalized) && safeGate(() =>
      runtimeController.canProcessGroupMessage(normalized));
  };
  const canUseForAnswer = (groupId: string): boolean => hasBaseGate(groupId)
    && safeGate(() => runtimeController.canReadDocuments())
    && safeGate(() => runtimeController.canRetrieveKnowledgeBase());
  const canUseForEvidence = (groupId: string): boolean => canUseForAnswer(groupId)
    && safeGate(() => runtimeController.canGenerateKnowledgeDrafts({ sourceGroupId: groupId }));
  const canUseForDelivery = (groupId: string): boolean => canUseForEvidence(groupId)
    && safeGate(() => runtimeController.canProactivelySpeak(groupId));

  const createPool = dependencies.createPostgresPool ??
    ((databaseConfig: DatabaseConfig) =>
      createPostgresPool(databaseConfig) as unknown as KnowledgeConflictPool);
  const compose = dependencies.createComposition ?? createDefaultComposition;
  let pool: KnowledgeConflictPool | undefined;
  let composition: KnowledgeConflictRuntimeComposition | undefined;
  try {
    pool = createPool({ databaseUrl: config.databaseUrl });
    composition = compose({
      pool,
      env,
      config,
      canUseForDelivery,
      canUseForEvidence,
      canUseForAnswer,
      getKnowledgeCardPresentationRuntime,
    });
  } catch (error) {
    const cleanup = observeStartupPromise(closeRuntimeResources([
      ...(pool === undefined ? [] : [() => pool!.end()]),
    ]));
    dependencies.onStartupCleanup?.(cleanup);
    throw error;
  }

  let startupPromise: Promise<void> | undefined;
  let closePromise: Promise<void> | undefined;
  let lifecycleGeneration = 0;
  const closeOwnedResources = ({ preserveFailure = false }: {
    preserveFailure?: boolean;
  } = {}): Promise<void> => {
    if (!preserveFailure && lifecycle !== "closed") {
      lifecycle = "closed";
      lifecycleGeneration += 1;
    }
    closePromise ??= observeStartupPromise(closeRuntimeResources([
      () => composition!.dispatcherLoop.stop(),
      () => composition!.scannerLoop.stop(),
      () => pool!.end(),
    ]));
    return closePromise;
  };

  const answerProvider: KnowledgeConflictAnswerProvider = {
    async findConflictPlan(input) {
      if (!canUseForAnswer(input.groupId)) return undefined;
      return composition!.answerProvider.findConflictPlan(input);
    },
    async validateForSend(input) {
      if (!canUseForAnswer(input.groupId)) return { status: "blocked" };
      return composition!.answerProvider.validateForSend?.(input) ?? { status: "blocked" };
    },
  };
  const interactionWorker: KnowledgeConflictInteractionDelegate = {
    processInteraction(job) {
      if (lifecycle !== "started") {
        return Promise.resolve({ status: "retryable", code: "internal_error" });
      }
      return composition!.interactionWorker.processInteraction(job);
    },
  };

  return {
    repository: composition.repository,
    currentValidator: composition.currentValidator,
    answerProvider,
    interactionWorker,
    canUseKnowledgeConflict: canUseForDelivery,
    start() {
      if (lifecycle === "closed") {
        return Promise.reject(new Error("knowledge conflict runtime is closed"));
      }
      if (startupPromise !== undefined) return startupPromise;
      lifecycle = "starting";
      const startupGeneration = ++lifecycleGeneration;
      startupPromise = observeStartupPromise((async () => {
        try {
          await composition!.prepare();
          requireCurrentStartup(lifecycle, lifecycleGeneration, startupGeneration);
          await composition!.scannerLoop.start();
          requireCurrentStartup(lifecycle, lifecycleGeneration, startupGeneration);
          composition!.dispatcherLoop.start();
          requireCurrentStartup(lifecycle, lifecycleGeneration, startupGeneration);
          lifecycle = "started";
        } catch (error) {
          const cancelled = !isCurrentStartup(
            lifecycle,
            lifecycleGeneration,
            startupGeneration,
          );
          const startupError = cancelled
            ? new Error("knowledge conflict runtime is closed")
            : error;
          if (!cancelled) lifecycle = "failed";
          try {
            await closeOwnedResources({ preserveFailure: !cancelled });
          } catch (cleanupError) {
            throw new AggregateError(
              [startupError, ...flattenErrors(cleanupError)],
              "Knowledge conflict runtime startup and cleanup failed",
            );
          }
          throw startupError;
        }
      })());
      return startupPromise;
    },
    async getStatus() {
      try {
        const scanner = composition!.scannerLoop.getSnapshot();
        const dispatcher = composition!.dispatcherLoop.getSnapshot();
        const migrations = await composition!.getRequiredMigrationStatus();
        const requiredMigrationsApplied = Object.values(migrations).every((applied) => applied);
        const [scans, candidates, deliveries, interactions] = requiredMigrationsApplied
          ? await Promise.all([
              composition!.repository.getScanStatusCounts(),
              composition!.repository.getCandidateStatusCounts(),
              composition!.repository.getDeliveryStatusCounts(),
              composition!.repository.getInteractionResultCounts(),
            ])
          : emptyDurableCounts();
        return {
          enabled: true,
          running: lifecycle === "started" && scanner.running && dispatcher.running,
          ...migrations,
          enabledGroupCount: enabledGroups.size,
          scanner,
          dispatcher,
          scans,
          candidates,
          deliveries,
          interactions,
          reconciliation: {
            terminalFailed: deliveries.terminalFailed,
            outcomeUnknown: deliveries.outcomeUnknown,
          },
        };
      } catch {
        throw new Error("knowledge conflict status unavailable");
      }
    },
    close: closeOwnedResources,
  };
}

function requireCurrentStartup(
  lifecycle: "idle" | "starting" | "started" | "failed" | "closed",
  lifecycleGeneration: number,
  startupGeneration: number,
): void {
  if (!isCurrentStartup(lifecycle, lifecycleGeneration, startupGeneration)) {
    throw new Error("knowledge conflict runtime is closed");
  }
}

function isCurrentStartup(
  lifecycle: "idle" | "starting" | "started" | "failed" | "closed",
  lifecycleGeneration: number,
  startupGeneration: number,
): boolean {
  return lifecycle === "starting" && lifecycleGeneration === startupGeneration;
}

function createDefaultComposition(
  input: KnowledgeConflictRuntimeCompositionInput,
): KnowledgeConflictRuntimeComposition {
  const modelConfig = readModelProviderConfig(input.env);
  const embeddingConfig = readEmbeddingProviderConfig(input.env);
  if (modelConfig === undefined || embeddingConfig?.dimensions === undefined) {
    throw new Error("knowledge conflict model dependencies are unavailable");
  }
  const feishuConfig = readFeishuOpenApiConfig(input.env);
  const profiles = createEmbeddingProfileRepository({ queryable: input.pool as never });
  const embeddingProfileId = createEmbeddingProfileId({
    provider: embeddingConfig.provider,
    model: embeddingConfig.model,
    dimensions: embeddingConfig.dimensions,
  });
  const fragments = createDocumentFragmentRepository({
    queryable: input.pool as never,
    embeddingProfiles: profiles,
  });
  const snapshots = createDocumentSnapshotRepository({ queryable: input.pool as never });
  const messages = createPostgresConversationMessageRepository({ queryable: input.pool as never });
  const documentSources = createPostgresDocumentSourceRegistry(input.pool as unknown as pg.Pool);
  const publicationTargets = createPostgresActionProposalRepository({ dataSource: input.pool as never });
  const managedPages = createPostgresManagedKnowledgePageRepository({
    dataSource: input.pool as never,
  });
  const drafts = createPostgresKnowledgeDraftRepository({ dataSource: input.pool as never });
  const repository = createPostgresKnowledgeConflictRepository({
    dataSource: input.pool,
    maxScanAttempts: input.config.scanMaxAttempts,
  });
  const tokenProvider = createFeishuTenantAccessTokenProvider({
    baseUrl: feishuConfig.baseUrl,
    appId: feishuConfig.appId,
    appSecret: feishuConfig.appSecret,
  });
  const permissionChecker = createFeishuDocumentPermissionChecker({
    baseUrl: feishuConfig.baseUrl,
    tokenProvider,
  });
  const botChatAccessChecker = createFeishuBotChatAccessChecker({
    baseUrl: feishuConfig.baseUrl,
    tokenProvider,
  });
  const membershipChecker = createFeishuGroupMembershipChecker({
    baseUrl: feishuConfig.baseUrl,
    tokenProvider,
  });
  const cardClient = createFeishuInteractiveCardClient({
    baseUrl: feishuConfig.baseUrl,
    tokenProvider,
  });
  const currentValidator = createKnowledgeConflictCurrentValidator({
    repository,
    documentSources,
    permissionChecker,
  });
  const evidenceBuilder = createKnowledgeConflictEvidenceBuilder({
    embeddingProfileId,
    embedder: createQueryEmbeddingProvider({
      model: embeddingConfig.model,
      delegate: createOpenAICompatibleEmbeddingProvider({ config: embeddingConfig }),
    }),
    fragments,
    messages,
    documentSources,
    snapshots,
    publicationTargets,
    permissionChecker,
  });
  const detector = createOpenAICompatibleKnowledgeConflictDetector({
    client: createOpenAICompatibleChatCompletionsClient({ config: modelConfig }),
  });
  const scanner = createKnowledgeConflictScanner({
    repository,
    evidenceBuilder,
    detector,
    documentSources,
    permissionChecker,
    groupIds: input.config.enabledGroupIds,
    canUseKnowledgeConflict: input.canUseForEvidence,
    workerId: SCANNER_WORKER_ID,
    leaseDurationMs: input.config.scanLeaseMs,
    retryBaseDelayMs: input.config.retryBaseDelayMs,
    retryMaxDelayMs: input.config.retryMaxDelayMs,
    detectorContractVersion: DETECTOR_CONTRACT_VERSION,
  });
  const dispatcher = createKnowledgeConflictDispatcher({
    repository,
    currentValidator,
    documentSources,
    cardClient,
    readDeliveryGates(groupId) {
      const open = input.canUseForDelivery(groupId);
      return {
        featureEnabled: open,
        groupAllowed: open,
        proactiveSpeech: open,
        retrieveKnowledgeBase: open,
        generateKnowledgeDrafts: open,
      };
    },
    isBotCurrentMember: (groupId) => botChatAccessChecker.canAccessChat({ chatId: groupId }),
    workerId: DISPATCHER_WORKER_ID,
    leaseMs: input.config.deliveryLeaseMs,
    retryBaseDelayMs: input.config.retryBaseDelayMs,
    retryMaxDelayMs: input.config.retryMaxDelayMs,
    reconciliationDelayMs: input.config.reconciliationDelayMs,
  });
  const scannerLoop = createKnowledgeConflictScannerLoop({
    scanner,
    intervalMs: input.config.scannerIntervalMs,
    batchLimit: input.config.scannerBatchLimit,
    onError: () => undefined,
  });
  const dispatcherLoop = createKnowledgeConflictDispatcherLoop({
    worker: dispatcher,
    intervalMs: input.config.dispatcherIntervalMs,
    batchLimit: input.config.dispatcherBatchLimit,
    onError: () => undefined,
  });
  const interactionWorker = createKnowledgeConflictInteractionWorker({
    repository,
    currentValidator,
    membershipChecker,
    drafts,
    publicationTargets,
    managedPages,
    cardRuntime: createLazyPresentationRuntime(input.getKnowledgeCardPresentationRuntime),
    canProcessKnowledgeConflicts: input.canUseForDelivery,
    botOpenId: input.config.botOpenId,
  });
  const answerProvider = createKnowledgeConflictAnswerProvider({
    repository,
    documentSources,
    permissionChecker,
  });

  return {
    repository,
    currentValidator,
    answerProvider,
    interactionWorker: createPresentationAwareInteractionDelegate(
      interactionWorker,
      input.getKnowledgeCardPresentationRuntime,
    ),
    scannerLoop,
    dispatcherLoop,
    canUseForEvidence: input.canUseForEvidence,
    canUseForAnswer: input.canUseForAnswer,
    async prepare() {
      try {
        await profiles.findOrCreateProfile({
          provider: embeddingConfig.provider,
          model: embeddingConfig.model,
          dimensions: embeddingConfig.dimensions!,
          displayName:
            `OpenAI-compatible ${embeddingConfig.model} (${embeddingConfig.dimensions}d)`,
        });
      } catch {
        throw new Error("knowledge conflict dependency startup failed");
      }
    },
    async getRequiredMigrationStatus() {
      const requiredNames = Object.values(REQUIRED_MIGRATIONS);
      const result = await input.pool.query<{ name: string }>(
        `select name
           from schema_migrations
          where name = any($1::text[])`,
        [requiredNames],
      );
      const present = new Set(result.rows.map(({ name }) => name));
      return {
        migration0046Applied: present.has(REQUIRED_MIGRATIONS.migration0046Applied),
        migration0047Applied: present.has(REQUIRED_MIGRATIONS.migration0047Applied),
        migration0048Applied: present.has(REQUIRED_MIGRATIONS.migration0048Applied),
      };
    },
  };
}

export function createPresentationAwareInteractionDelegate(
  worker: KnowledgeConflictInteractionDelegate,
  getRuntime: () => KnowledgeDraftPresentationRuntime | undefined,
): KnowledgeConflictInteractionDelegate {
  return {
    processInteraction(job) {
      if (job.action === "create_update_draft") {
        try {
          if (getRuntime() === undefined) {
            return Promise.resolve({ status: "retryable", code: "internal_error" });
          }
        } catch {
          return Promise.resolve({ status: "retryable", code: "internal_error" });
        }
      }
      return worker.processInteraction(job);
    },
  };
}

function createLazyPresentationRuntime(
  getRuntime: () => KnowledgeDraftPresentationRuntime | undefined,
): KnowledgeDraftPresentationRuntime {
  const repository = new Proxy({} as KnowledgeDraftPresentationRuntime["repository"], {
    get(_target, property) {
      const runtime = getRuntime();
      if (runtime === undefined) return () => Promise.reject(new Error("presentation unavailable"));
      const value = Reflect.get(runtime.repository, property);
      return typeof value === "function" ? value.bind(runtime.repository) : value;
    },
  });
  return {
    repository,
    canUseKnowledgeCards(groupId) {
      const runtime = getRuntime();
      if (runtime === undefined) return false;
      try {
        return runtime.canUseKnowledgeCards(groupId);
      } catch {
        return false;
      }
    },
  };
}

function normalizeGroupId(value: string): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= 512 ? normalized : undefined;
}

function safeGate(read: () => boolean): boolean {
  try {
    return read() === true;
  } catch {
    return false;
  }
}

function emptyDurableCounts(): [
  KnowledgeConflictScanStatusCounts,
  KnowledgeConflictCandidateStatusCounts,
  KnowledgeConflictDeliveryStatusCounts,
  KnowledgeConflictInteractionResultCounts,
] {
  return [
    { pending: 0, processing: 0, retry: 0, completed: 0, deadLettered: 0 },
    {
      pending_review: 0,
      dismissed: 0,
      approved_for_delivery: 0,
      delivered: 0,
      draft_created: 0,
      superseded: 0,
    },
    {
      pending: 0,
      processing: 0,
      externalAttempting: 0,
      sent: 0,
      failed: 0,
      terminalFailed: 0,
      outcomeUnknown: 0,
      cancelled: 0,
    },
    { applied: 0, alreadyApplied: 0, rejected: 0 },
  ];
}

function flattenErrors(error: unknown): unknown[] {
  return error instanceof AggregateError
    ? error.errors.flatMap((nested) => flattenErrors(nested))
    : [error];
}
