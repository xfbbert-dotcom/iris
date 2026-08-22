import type { RuntimeController } from "../admin/runtime-controller.js";
import {
  readFeishuOpenApiConfig,
  readFeishuTaskCreationDeploymentConfig,
  type EnvLike,
} from "../config/env.js";
import { createFeishuTenantAccessTokenProvider } from
  "../feishu/feishu-tenant-access-token-provider.js";
import { createFeishuTaskCreator } from "../formal-tasks/feishu-task-creator.js";
import { createFeishuTaskExecutor } from "../formal-tasks/feishu-task-executor.js";
import { createFeishuTaskReconciler } from "../formal-tasks/feishu-task-reconciler.js";
import { createFeishuTaskResultDispatcher } from
  "../formal-tasks/feishu-task-result-dispatcher.js";
import {
  createFeishuTaskExecutionLoop,
  type FeishuTaskExecutionLoopSnapshot,
} from "../formal-tasks/feishu-task-execution-loop.js";
import type {
  FormalTaskExecutionRepository,
  FormalTaskExecutionStatusCounts,
} from "../formal-tasks/formal-task-execution-repository.js";
import type { KnowledgeCardRuntime } from "./knowledge-card-runtime.js";

const EXECUTOR_WORKER_ID = "formal-task-executor";
const RECONCILER_WORKER_ID = "formal-task-reconciler";
const RESULT_DISPATCHER_WORKER_ID = "formal-task-result-dispatcher";

type FormalTaskActionRuntimeGate = Pick<RuntimeController, "getSnapshot">;

export type FormalTaskActionRuntimeStatus = {
  enabled: true;
  deploymentEnabled: boolean;
  running: boolean;
  enabledGroupCount: number;
  runtimeCreationEnabled: boolean;
  worker?: FeishuTaskExecutionLoopSnapshot;
  counts: FormalTaskExecutionStatusCounts;
};

export type FormalTaskActionRuntime = {
  repository: FormalTaskExecutionRepository;
  canUseFormalTaskActionsForSourceGroup(groupId: string): boolean;
  start(): Promise<void>;
  getStatus(): Promise<FormalTaskActionRuntimeStatus>;
  close(): Promise<void>;
};

export type FormalTaskActionRuntimeDependencies = {
  createFeishuTenantAccessTokenProvider?: typeof createFeishuTenantAccessTokenProvider;
  createFeishuTaskCreator?: typeof createFeishuTaskCreator;
  createExecutor?: typeof createFeishuTaskExecutor;
  createReconciler?: typeof createFeishuTaskReconciler;
  createResultDispatcher?: typeof createFeishuTaskResultDispatcher;
  createExecutionLoop?: typeof createFeishuTaskExecutionLoop;
};

export function createFormalTaskActionRuntime({
  env = process.env,
  runtimeController,
  executionRepository,
  knowledgeCardRuntime,
  dependencies = {},
}: {
  env?: EnvLike;
  runtimeController?: FormalTaskActionRuntimeGate;
  executionRepository?: FormalTaskExecutionRepository;
  knowledgeCardRuntime?: Pick<KnowledgeCardRuntime, "approvalInteractions">;
  dependencies?: FormalTaskActionRuntimeDependencies;
} = {}): FormalTaskActionRuntime | undefined {
  if (executionRepository === undefined) return undefined;
  if (runtimeController === undefined) {
    throw new Error("runtimeController is required for formal task action governance");
  }
  const config = readFeishuTaskCreationDeploymentConfig(env);
  if (config.enabled && knowledgeCardRuntime === undefined) {
    throw new Error("knowledgeCardRuntime is required when Feishu task creation is enabled");
  }

  let lifecycle: "idle" | "started" | "closed" = "idle";
  let executionLoop: ReturnType<typeof createFeishuTaskExecutionLoop> | undefined;

  const runtimeSnapshot = () => {
    const snapshot = runtimeController.getSnapshot();
    return {
      deploymentEnabled: config.enabled,
      globalEnabled: snapshot.globalEnabled,
      groupAllowlist: [...config.groupAllowlist],
      disabledGroupIds: [...snapshot.disabledGroupIds],
      capabilities: {
        createFeishuTasks: snapshot.capabilities.createFeishuTasks,
        callExternalTools: snapshot.capabilities.callExternalTools,
      },
    };
  };
  const canUseGroup = (groupId: string): boolean => {
    if (lifecycle === "closed") return false;
    let snapshot: ReturnType<typeof runtimeSnapshot>;
    try {
      snapshot = runtimeSnapshot();
    } catch {
      return false;
    }
    const normalized = normalizeGroupId(groupId);
    return snapshot.deploymentEnabled && snapshot.globalEnabled &&
      snapshot.capabilities.createFeishuTasks && snapshot.capabilities.callExternalTools &&
      snapshot.groupAllowlist.includes(normalized) &&
      !snapshot.disabledGroupIds.includes(normalized);
  };

  if (config.enabled) {
    const feishuConfig = readFeishuOpenApiConfig(env);
    const tokenProvider = (
      dependencies.createFeishuTenantAccessTokenProvider ?? createFeishuTenantAccessTokenProvider
    )({
      baseUrl: feishuConfig.baseUrl,
      appId: feishuConfig.appId,
      appSecret: feishuConfig.appSecret,
    });
    const creator = (dependencies.createFeishuTaskCreator ?? createFeishuTaskCreator)({
      baseUrl: feishuConfig.baseUrl,
      tokenProvider,
    });
    const executor = (dependencies.createExecutor ?? createFeishuTaskExecutor)({
      repository: executionRepository,
      creator,
      membershipChecker: knowledgeCardRuntime!.approvalInteractions.membershipChecker,
      runtimeSnapshot,
      workerId: EXECUTOR_WORKER_ID,
      leaseMs: config.leaseMs,
      retryDelayMs: config.retryDelayMs,
      reconciliationDelayMs: config.reconciliationDelayMs,
      maxAttempts: config.maxAttempts,
    });
    const reconciler = (dependencies.createReconciler ?? createFeishuTaskReconciler)({
      repository: executionRepository,
      creator,
      membershipChecker: knowledgeCardRuntime!.approvalInteractions.membershipChecker,
      runtimeSnapshot,
      workerId: RECONCILER_WORKER_ID,
      leaseMs: config.leaseMs,
      reconciliationDelayMs: config.reconciliationDelayMs,
      maxAttempts: config.maxAttempts,
    });
    const resultDispatcher = (
      dependencies.createResultDispatcher ?? createFeishuTaskResultDispatcher
    )({
      repository: executionRepository,
      cardClient: knowledgeCardRuntime!.approvalInteractions.cardClient,
      canSendResultCards: canUseGroup,
      workerId: RESULT_DISPATCHER_WORKER_ID,
      leaseMs: config.leaseMs,
      retryDelayMs: config.retryDelayMs,
    });
    executionLoop = (dependencies.createExecutionLoop ?? createFeishuTaskExecutionLoop)({
      executor,
      reconciler,
      resultDispatcher,
      intervalMs: config.intervalMs,
      batchLimit: config.batchLimit,
      onError: () => undefined,
    });
  }

  let closePromise: Promise<void> | undefined;
  return {
    repository: executionRepository,
    canUseFormalTaskActionsForSourceGroup: canUseGroup,
    async start() {
      if (lifecycle === "closed") throw new Error("formal task action runtime is closed");
      if (lifecycle === "started") return;
      lifecycle = "started";
      executionLoop?.start();
    },
    async getStatus() {
      const worker = executionLoop?.getSnapshot();
      return {
        enabled: true,
        deploymentEnabled: config.enabled,
        running: worker?.running === true,
        enabledGroupCount: config.groupAllowlist.length,
        runtimeCreationEnabled: config.groupAllowlist.some((groupId) => canUseGroup(groupId)),
        worker,
        counts: await executionRepository.getStatusCounts(),
      };
    },
    close() {
      lifecycle = "closed";
      closePromise ??= executionLoop?.stop() ?? Promise.resolve();
      return closePromise;
    },
  };
}

function normalizeGroupId(value: unknown): string {
  if (typeof value !== "string") return "";
  const normalized = value.trim();
  if (
    normalized !== value || normalized.length < 1 || normalized.length > 512 ||
    /[\u0000-\u001f\u007f]/u.test(normalized)
  ) return "";
  return normalized;
}
