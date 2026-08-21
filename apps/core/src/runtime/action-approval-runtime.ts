import type { RuntimeController } from "../admin/runtime-controller.js";
import type { AgentExecutionObserver } from "../agent-runtime/agent-execution-observer.js";
import { createActionApprovalDispatcher } from "../action-approvals/action-approval-dispatcher.js";
import {
  createActionApprovalDispatcherLoop,
  type ActionApprovalDispatcherLoopSnapshot,
} from "../action-approvals/action-approval-dispatcher-loop.js";
import { createActionApprovalWorker } from "../action-approvals/action-approval-worker.js";
import {
  createFeishuKnowledgePublicationPublisher,
} from "../action-approvals/feishu-knowledge-publication-publisher.js";
import { createFeishuManagedKnowledgeBlockReader } from
  "../action-approvals/feishu-managed-knowledge-block-reader.js";
import { createFeishuManagedKnowledgeUpdater } from
  "../action-approvals/feishu-managed-knowledge-updater.js";
import {
  createKnowledgePublicationExecutor,
} from "../action-approvals/knowledge-publication-executor.js";
import {
  createKnowledgePublicationExecutorLoop,
  type KnowledgePublicationExecutorLoopSnapshot,
} from "../action-approvals/knowledge-publication-executor-loop.js";
import { createManagedKnowledgeUpdateExecutor } from
  "../action-approvals/managed-knowledge-update-executor.js";
import {
  createManagedKnowledgeUpdateExecutorLoop,
  type ManagedKnowledgeUpdateExecutorLoopSnapshot,
} from "../action-approvals/managed-knowledge-update-executor-loop.js";
import { createManagedKnowledgeUpdateReconciler } from
  "../action-approvals/managed-knowledge-update-reconciler.js";
import { createActionProposalPlanner } from "../action-approvals/action-proposal-planner.js";
import {
  createActionProposalPlannerLoop,
  type ActionProposalPlannerLoop,
} from "../action-approvals/action-proposal-planner-loop.js";
import type {
  ActionApprovalOutboxStatusCounts,
  ActionProposalRepository,
  ActionProposalStatusCounts,
} from "../action-approvals/action-proposal-repository.js";
import { createPostgresActionProposalRepository } from "../action-approvals/postgres-action-proposal-repository.js";
import { createPostgresManagedKnowledgePageRepository } from
  "../action-approvals/postgres-managed-knowledge-page-repository.js";
import {
  readActionApprovalRuntimeConfig,
  readFeishuOpenApiConfig,
  type EnvLike,
} from "../config/env.js";
import type { DatabaseConfig } from "../database/database-config.js";
import { createPostgresPool } from "../database/postgres.js";
import { createFeishuTenantAccessTokenProvider } from "../feishu/feishu-tenant-access-token-provider.js";
import type { PostgresKnowledgeDraftDataSource } from "../knowledge-governance/postgres-knowledge-draft-repository.js";
import type { DocumentSyncQueue } from "../documents/document-sync-queue.js";
import type {
  ManagedKnowledgeReconciliationRequest,
  ManagedKnowledgeUpdateMetadata,
} from "../action-approvals/managed-knowledge-page-repository.js";
import { closeRuntimeResources } from "./runtime-close.js";
import type { KnowledgeCardRuntime } from "./knowledge-card-runtime.js";
import { observeStartupPromise } from "./startup-promise.js";

const DISPATCHER_WORKER_ID = "action-approval-dispatcher";
const EXTERNAL_LEASE_MS = 30_000;
const SEND_RETRY_DELAY_MS = 1_000;

type ActionApprovalPool = PostgresKnowledgeDraftDataSource & { end(): Promise<void> };
type ActionApprovalRuntimeGate = Pick<
  RuntimeController,
  "canGenerateKnowledgeDrafts" | "getSnapshot"
>;

export type ActionApprovalRuntimeStatus = {
  enabled: true;
  running: boolean;
  enabledGroupCount: number;
  planner: ReturnType<ActionProposalPlannerLoop["getSnapshot"]>;
  dispatcher: ActionApprovalDispatcherLoopSnapshot;
  publicationExecutor: KnowledgePublicationExecutorLoopSnapshot;
  managedKnowledgeUpdates?: ManagedKnowledgeUpdateExecutorLoopSnapshot & {
    migration0055Applied: boolean;
    reconciliation: {
      outcomeUnknown: number;
      reconciliationRequired: number;
    };
  };
  proposals: ActionProposalStatusCounts;
  outbox: ActionApprovalOutboxStatusCounts;
};

export type ManagedKnowledgeUpdateRuntimeConfiguration = {
  deploymentEnabled: boolean;
  groupAllowlist: readonly string[];
  syncQueue: Pick<DocumentSyncQueue, "enqueue">;
  intervalMs: number;
  batchLimit: number;
  staleDispatchMs: number;
};

export type ActionApprovalRuntime = {
  repository: ActionProposalRepository;
  managedKnowledgeAdmin?: {
    getProposalMetadata(proposalId: string): Promise<ManagedKnowledgeUpdateMetadata | undefined>;
    reconcile(input: ManagedKnowledgeReconciliationRequest): Promise<{
      executionId: string;
      state: "applied" | "retry_same_token" | "reconciliation_required";
      version: number;
      reasonCode: string;
    }>;
  };
  canUseActionApprovalsForSourceGroup(groupId?: string): boolean;
  start(): Promise<void>;
  getStatus(): Promise<ActionApprovalRuntimeStatus>;
  close(): Promise<void>;
};

export type ActionApprovalRuntimeDependencies = {
  createPostgresPool?: (config: DatabaseConfig) => ActionApprovalPool;
  createRepository?: typeof createPostgresActionProposalRepository;
  createPlanner?: typeof createActionProposalPlanner;
  createDispatcher?: typeof createActionApprovalDispatcher;
  createActionWorker?: typeof createActionApprovalWorker;
  createFeishuTenantAccessTokenProvider?: typeof createFeishuTenantAccessTokenProvider;
  createPublicationPublisher?: typeof createFeishuKnowledgePublicationPublisher;
  createPublicationExecutor?: typeof createKnowledgePublicationExecutor;
  createPlannerLoop?: typeof createActionProposalPlannerLoop;
  createDispatcherLoop?: typeof createActionApprovalDispatcherLoop;
  createPublicationExecutorLoop?: typeof createKnowledgePublicationExecutorLoop;
  createManagedPageRepository?: typeof createPostgresManagedKnowledgePageRepository;
  createManagedBlockReader?: typeof createFeishuManagedKnowledgeBlockReader;
  createManagedUpdater?: typeof createFeishuManagedKnowledgeUpdater;
  createManagedUpdateExecutor?: typeof createManagedKnowledgeUpdateExecutor;
  createManagedUpdateReconciler?: typeof createManagedKnowledgeUpdateReconciler;
  createManagedUpdateLoop?: typeof createManagedKnowledgeUpdateExecutorLoop;
  onStartupCleanup?: (cleanup: Promise<void>) => void;
};

export function createActionApprovalRuntime({
  env = process.env,
  runtimeController,
  knowledgeCardRuntime,
  dependencies = {},
  agentExecutionObserver,
  managedKnowledgeUpdates,
}: {
  env?: EnvLike;
  runtimeController?: ActionApprovalRuntimeGate;
  knowledgeCardRuntime?: KnowledgeCardRuntime;
  dependencies?: ActionApprovalRuntimeDependencies;
  agentExecutionObserver?: AgentExecutionObserver;
  managedKnowledgeUpdates?: ManagedKnowledgeUpdateRuntimeConfiguration;
} = {}): ActionApprovalRuntime | undefined {
  const config = readActionApprovalRuntimeConfig(env);
  if (!config.enabled) return undefined;
  if (runtimeController === undefined) {
    throw new Error("runtimeController is required when action approvals are enabled");
  }
  if (knowledgeCardRuntime === undefined) {
    throw new Error("knowledgeCardRuntime is required when action approvals are enabled");
  }

  const createPool = dependencies.createPostgresPool ?? createPostgresPool;
  const createRepository = dependencies.createRepository ?? createPostgresActionProposalRepository;
  const createPlanner = dependencies.createPlanner ?? createActionProposalPlanner;
  const createDispatcher = dependencies.createDispatcher ?? createActionApprovalDispatcher;
  const createWorker = dependencies.createActionWorker ?? createActionApprovalWorker;
  const createTokenProvider = dependencies.createFeishuTenantAccessTokenProvider ??
    createFeishuTenantAccessTokenProvider;
  const createPublisher = dependencies.createPublicationPublisher ?? createFeishuKnowledgePublicationPublisher;
  const createPublicationExecution = dependencies.createPublicationExecutor ?? createKnowledgePublicationExecutor;
  const createPlannerPollingLoop = dependencies.createPlannerLoop ?? createActionProposalPlannerLoop;
  const createDispatcherPollingLoop = dependencies.createDispatcherLoop ?? createActionApprovalDispatcherLoop;
  const createPublicationPollingLoop = dependencies.createPublicationExecutorLoop ??
    createKnowledgePublicationExecutorLoop;
  const createManagedPageRepository = dependencies.createManagedPageRepository ??
    createPostgresManagedKnowledgePageRepository;
  const createManagedBlockReader = dependencies.createManagedBlockReader ??
    createFeishuManagedKnowledgeBlockReader;
  const createManagedUpdater = dependencies.createManagedUpdater ?? createFeishuManagedKnowledgeUpdater;
  const createManagedUpdateExecution = dependencies.createManagedUpdateExecutor ??
    createManagedKnowledgeUpdateExecutor;
  const createManagedUpdateReconciliation = dependencies.createManagedUpdateReconciler ??
    createManagedKnowledgeUpdateReconciler;
  const createManagedUpdatePollingLoop = dependencies.createManagedUpdateLoop ??
    createManagedKnowledgeUpdateExecutorLoop;
  const enabledGroups = new Set(config.enabledGroupIds);
  const requireReviewAttestation = env.IRIS_ACTION_REVIEW_ENABLED === "true";
  let pool: ActionApprovalPool | undefined;
  let plannerLoop: ActionProposalPlannerLoop | undefined;
  let dispatcherLoop: ReturnType<typeof createActionApprovalDispatcherLoop> | undefined;
  let publicationExecutorLoop: ReturnType<typeof createKnowledgePublicationExecutorLoop> | undefined;
  let managedUpdateLoop: ReturnType<typeof createManagedKnowledgeUpdateExecutorLoop> | undefined;
  let managedKnowledgeAdmin: ActionApprovalRuntime["managedKnowledgeAdmin"];
  let lifecycle: "idle" | "started" | "closed" = "idle";

  const canUseGroup = (groupId?: string): boolean => {
    if (lifecycle !== "started" || groupId === undefined) return false;
    const normalized = groupId.trim();
    if (normalized.length === 0 || !enabledGroups.has(normalized)) return false;
    try {
      return runtimeController.canGenerateKnowledgeDrafts({ sourceGroupId: normalized });
    } catch {
      return false;
    }
  };
  const anyGroupEnabled = (): boolean => config.enabledGroupIds.some((groupId) => canUseGroup(groupId));

  try {
    pool = createPool({ databaseUrl: config.databaseUrl });
    const repository = createRepository({ dataSource: pool });
    const feishuConfig = readFeishuOpenApiConfig(env);
    const tokenProvider = createTokenProvider({
      baseUrl: feishuConfig.baseUrl,
      appId: feishuConfig.appId,
      appSecret: feishuConfig.appSecret,
    });
    const planner = createPlanner({
      repository,
      getAllowedGroupIds: () => config.enabledGroupIds.filter((groupId) => canUseGroup(groupId)),
      ...(agentExecutionObserver === undefined ? {} : { agentExecutionObserver }),
    });
    const dispatcher = createDispatcher({
      repository,
      cardClient: knowledgeCardRuntime.approvalInteractions.cardClient,
      canDeliverApprovalCards: canUseGroup,
      ...(config.reviewPublicOrigin === undefined
        ? {}
        : { reviewPublicOrigin: config.reviewPublicOrigin }),
      workerId: DISPATCHER_WORKER_ID,
      leaseMs: EXTERNAL_LEASE_MS,
      retryDelayMs: SEND_RETRY_DELAY_MS,
    });
    const actionWorker = createWorker({
      repository,
      membershipChecker: knowledgeCardRuntime.approvalInteractions.membershipChecker,
      cardClient: knowledgeCardRuntime.approvalInteractions.cardClient,
      isActionApprovalRuntimeEnabled: anyGroupEnabled,
      canUseActionApprovalsForSourceGroup: canUseGroup,
      requireReviewAttestation,
      botOpenId: knowledgeCardRuntime.approvalInteractions.botOpenId,
      ...(agentExecutionObserver === undefined ? {} : { agentExecutionObserver }),
    });
    const publisher = createPublisher({
      baseUrl: feishuConfig.baseUrl,
      tokenProvider,
    });
    const publicationExecutor = createPublicationExecution({
      repository,
      publisher,
      runtimeSnapshot: () => {
        const snapshot = runtimeController.getSnapshot();
        return {
          globalEnabled: snapshot.globalEnabled,
          disabledGroupIds: snapshot.disabledGroupIds,
          capabilities: { writeKnowledgeBase: snapshot.capabilities.writeKnowledgeBase },
        };
      },
      workerId: "knowledge-publication-executor",
      ...(agentExecutionObserver === undefined ? {} : { agentExecutionObserver }),
    });
    if (managedKnowledgeUpdates !== undefined &&
      typeof managedKnowledgeUpdates.syncQueue?.enqueue === "function") {
      const groupAllowlist = managedKnowledgeUpdates.deploymentEnabled
        ? normalizeGroupAllowlist(managedKnowledgeUpdates.groupAllowlist)
        : [];
      const managedPages = createManagedPageRepository({ dataSource: pool });
      const managedBlockReader = createManagedBlockReader({
        baseUrl: feishuConfig.baseUrl,
        tokenProvider,
      });
      const managedUpdater = createManagedUpdater({
        baseUrl: feishuConfig.baseUrl,
        tokenProvider,
        blockReader: managedBlockReader,
      });
      const managedUpdateExecutor = createManagedUpdateExecution({
        proposals: repository,
        managedPages,
        updater: managedUpdater,
        syncQueue: managedKnowledgeUpdates.syncQueue,
        runtimeSnapshot: () => {
          const snapshot = runtimeController.getSnapshot();
          return {
            deploymentEnabled: managedKnowledgeUpdates.deploymentEnabled,
            globalEnabled: snapshot.globalEnabled,
            disabledGroupIds: snapshot.disabledGroupIds,
            groupAllowlist,
            capabilities: {
              writeKnowledgeBase: snapshot.capabilities.writeKnowledgeBase,
              updateManagedKnowledge: snapshot.capabilities.updateManagedKnowledge,
            },
          };
        },
        workerId: "managed-knowledge-update-executor",
        ...(agentExecutionObserver === undefined ? {} : { agentExecutionObserver }),
      });
      const managedUpdateReconciler = createManagedUpdateReconciliation({
        managedPages,
        updater: managedUpdater,
        syncQueue: managedKnowledgeUpdates.syncQueue,
        workerId: "managed-knowledge-update-reconciler",
        staleDispatchMs: managedKnowledgeUpdates.staleDispatchMs,
      });
      managedUpdateLoop = createManagedUpdatePollingLoop({
        executor: managedUpdateExecutor,
        reconciler: managedUpdateReconciler,
        intervalMs: managedKnowledgeUpdates.intervalMs,
        batchLimit: managedKnowledgeUpdates.batchLimit,
        onError: () => undefined,
      });
      managedKnowledgeAdmin = {
        getProposalMetadata(proposalId) {
          return managedPages.getMetadataForProposal(proposalId);
        },
        async reconcile(input) {
          const requested = await managedPages.requestReconciliation(input);
          if (requested.outcome === "already_applied") {
            return {
              executionId: requested.claim.execution.id,
              state: "reconciliation_required",
              version: requested.claim.execution.version,
              reasonCode: requested.claim.execution.reconciliationReasonCode ?? "operator_requested",
            };
          }
          const result = await managedUpdateReconciler.reconcileOne(requested.claim);
          return {
            executionId: result.executionId,
            state: result.status,
            version: requested.claim.execution.version,
            reasonCode: result.code,
          };
        },
      };
    }
    plannerLoop = createPlannerPollingLoop({
      planner,
      canRun: anyGroupEnabled,
      intervalMs: config.plannerIntervalMs,
      batchLimit: config.plannerBatchLimit,
      onError: () => undefined,
    });
    dispatcherLoop = createDispatcherPollingLoop({
      worker: dispatcher,
      intervalMs: config.dispatcherIntervalMs,
      batchLimit: config.dispatcherBatchLimit,
      onError: () => undefined,
    });
    publicationExecutorLoop = createPublicationPollingLoop({
      executor: publicationExecutor,
      intervalMs: config.publicationExecutorIntervalMs,
      batchLimit: config.publicationExecutorBatchLimit,
      onError: () => undefined,
    });
    knowledgeCardRuntime.bindActionApprovalWorker(actionWorker);

    let closePromise: Promise<void> | undefined;
    const close = (): Promise<void> => {
      lifecycle = "closed";
      closePromise ??= observeStartupPromise(closeRuntimeResources([
        ...(managedUpdateLoop === undefined ? [] : [() => managedUpdateLoop!.stop()]),
        () => publicationExecutorLoop!.stop(),
        () => dispatcherLoop!.stop(),
        () => plannerLoop!.stop(),
        () => pool!.end(),
      ]));
      return closePromise;
    };

    return {
      repository,
      ...(managedKnowledgeAdmin === undefined ? {} : { managedKnowledgeAdmin }),
      canUseActionApprovalsForSourceGroup: canUseGroup,
      async start() {
        if (lifecycle === "closed") throw new Error("action approval runtime is closed");
        if (lifecycle === "started") return;
        lifecycle = "started";
        try {
          plannerLoop!.start();
          dispatcherLoop!.start();
          publicationExecutorLoop!.start();
          managedUpdateLoop?.start();
        } catch (error) {
          await close();
          throw error;
        }
      },
      async getStatus() {
        const planner = plannerLoop!.getSnapshot();
        const dispatcher = dispatcherLoop!.getSnapshot();
        const publicationExecutor = publicationExecutorLoop!.getSnapshot();
        const managedKnowledgeUpdateSnapshot = managedUpdateLoop?.getSnapshot();
        const [proposals, outbox, managedKnowledgeUpdateReadiness] = await Promise.all([
          repository.getStatusCounts(),
          repository.getApprovalOutboxStatusCounts(),
          managedKnowledgeUpdateSnapshot === undefined
            ? Promise.resolve(undefined)
            : getManagedKnowledgeUpdateReadiness(pool!),
        ]);
        return {
          enabled: true,
          running: planner.running && dispatcher.running && publicationExecutor.running &&
            (managedKnowledgeUpdateSnapshot?.running ?? true),
          enabledGroupCount: enabledGroups.size,
          planner,
          dispatcher,
          publicationExecutor,
          ...(managedKnowledgeUpdateSnapshot === undefined
            ? {}
            : {
                managedKnowledgeUpdates: {
                  ...managedKnowledgeUpdateSnapshot,
                  ...managedKnowledgeUpdateReadiness!,
                },
              }),
          proposals,
          outbox,
        };
      },
      close,
    };
  } catch (error) {
    const cleanup = observeStartupPromise(closeRuntimeResources([
      ...(publicationExecutorLoop === undefined ? [] : [() => publicationExecutorLoop!.stop()]),
      ...(dispatcherLoop === undefined ? [] : [() => dispatcherLoop!.stop()]),
      ...(plannerLoop === undefined ? [] : [() => plannerLoop!.stop()]),
      ...(managedUpdateLoop === undefined ? [] : [() => managedUpdateLoop!.stop()]),
      ...(pool === undefined ? [] : [() => pool!.end()]),
    ]));
    dependencies.onStartupCleanup?.(cleanup);
    throw error;
  }
}

async function getManagedKnowledgeUpdateReadiness(
  pool: Pick<PostgresKnowledgeDraftDataSource, "query">,
): Promise<{
  migration0055Applied: boolean;
  reconciliation: { outcomeUnknown: number; reconciliationRequired: number };
}> {
  const result = await pool.query<{
    present: boolean;
    outcome_unknown: string | number;
    reconciliation_required: string | number;
  }>(
    `SELECT EXISTS (
       SELECT 1 FROM schema_migrations WHERE name = '0055_managed_update_execution_identity.sql'
     ) AS present,
     COUNT(*) FILTER (WHERE state = 'outcome_unknown') AS outcome_unknown,
     COUNT(*) FILTER (WHERE state = 'reconciliation_required') AS reconciliation_required
     FROM knowledge_publication_update_executions`,
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error("managed knowledge update readiness is unavailable");
  return {
    migration0055Applied: row.present === true,
    reconciliation: {
      outcomeUnknown: requireSafeCount(row.outcome_unknown),
      reconciliationRequired: requireSafeCount(row.reconciliation_required),
    },
  };
}

function requireSafeCount(value: string | number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error("managed knowledge update readiness is unavailable");
  }
  return parsed;
}

function normalizeGroupAllowlist(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 100) {
    throw new Error("managed update group allowlist is invalid");
  }
  const groups = value.map((item) => {
    if (typeof item !== "string") throw new Error("managed update group allowlist is invalid");
    const normalized = item.trim();
    if (normalized.length < 1 || normalized.length > 512) {
      throw new Error("managed update group allowlist is invalid");
    }
    return normalized;
  });
  return [...new Set(groups)].sort();
}
