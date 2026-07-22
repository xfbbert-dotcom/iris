import type { RuntimeController } from "../admin/runtime-controller.js";
import { createActionApprovalDispatcher } from "../action-approvals/action-approval-dispatcher.js";
import {
  createActionApprovalDispatcherLoop,
  type ActionApprovalDispatcherLoopSnapshot,
} from "../action-approvals/action-approval-dispatcher-loop.js";
import { createActionApprovalWorker } from "../action-approvals/action-approval-worker.js";
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
import {
  readActionApprovalRuntimeConfig,
  type EnvLike,
} from "../config/env.js";
import type { DatabaseConfig } from "../database/database-config.js";
import { createPostgresPool } from "../database/postgres.js";
import type { PostgresKnowledgeDraftDataSource } from "../knowledge-governance/postgres-knowledge-draft-repository.js";
import { closeRuntimeResources } from "./runtime-close.js";
import type { KnowledgeCardRuntime } from "./knowledge-card-runtime.js";
import { observeStartupPromise } from "./startup-promise.js";

const DISPATCHER_WORKER_ID = "action-approval-dispatcher";
const EXTERNAL_LEASE_MS = 30_000;
const SEND_RETRY_DELAY_MS = 1_000;

type ActionApprovalPool = PostgresKnowledgeDraftDataSource & { end(): Promise<void> };
type ActionApprovalRuntimeGate = Pick<RuntimeController, "canGenerateKnowledgeDrafts">;

export type ActionApprovalRuntimeStatus = {
  enabled: true;
  running: boolean;
  enabledGroupCount: number;
  planner: ReturnType<ActionProposalPlannerLoop["getSnapshot"]>;
  dispatcher: ActionApprovalDispatcherLoopSnapshot;
  proposals: ActionProposalStatusCounts;
  outbox: ActionApprovalOutboxStatusCounts;
};

export type ActionApprovalRuntime = {
  repository: ActionProposalRepository;
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
  createPlannerLoop?: typeof createActionProposalPlannerLoop;
  createDispatcherLoop?: typeof createActionApprovalDispatcherLoop;
  onStartupCleanup?: (cleanup: Promise<void>) => void;
};

export function createActionApprovalRuntime({
  env = process.env,
  runtimeController,
  knowledgeCardRuntime,
  dependencies = {},
}: {
  env?: EnvLike;
  runtimeController?: ActionApprovalRuntimeGate;
  knowledgeCardRuntime?: KnowledgeCardRuntime;
  dependencies?: ActionApprovalRuntimeDependencies;
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
  const createPlannerPollingLoop = dependencies.createPlannerLoop ?? createActionProposalPlannerLoop;
  const createDispatcherPollingLoop = dependencies.createDispatcherLoop ?? createActionApprovalDispatcherLoop;
  const enabledGroups = new Set(config.enabledGroupIds);
  let pool: ActionApprovalPool | undefined;
  let plannerLoop: ActionProposalPlannerLoop | undefined;
  let dispatcherLoop: ReturnType<typeof createActionApprovalDispatcherLoop> | undefined;
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
    const planner = createPlanner({
      repository,
      getAllowedGroupIds: () => config.enabledGroupIds.filter((groupId) => canUseGroup(groupId)),
    });
    const dispatcher = createDispatcher({
      repository,
      cardClient: knowledgeCardRuntime.approvalInteractions.cardClient,
      canDeliverApprovalCards: anyGroupEnabled,
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
      botOpenId: knowledgeCardRuntime.approvalInteractions.botOpenId,
    });
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
    knowledgeCardRuntime.bindActionApprovalWorker(actionWorker);

    let closePromise: Promise<void> | undefined;
    const close = (): Promise<void> => {
      lifecycle = "closed";
      closePromise ??= observeStartupPromise(closeRuntimeResources([
        () => dispatcherLoop!.stop(),
        () => plannerLoop!.stop(),
        () => pool!.end(),
      ]));
      return closePromise;
    };

    return {
      repository,
      canUseActionApprovalsForSourceGroup: canUseGroup,
      async start() {
        if (lifecycle === "closed") throw new Error("action approval runtime is closed");
        if (lifecycle === "started") return;
        lifecycle = "started";
        try {
          plannerLoop!.start();
          dispatcherLoop!.start();
        } catch (error) {
          await close();
          throw error;
        }
      },
      async getStatus() {
        const planner = plannerLoop!.getSnapshot();
        const dispatcher = dispatcherLoop!.getSnapshot();
        const [proposals, outbox] = await Promise.all([
          repository.getStatusCounts(),
          repository.getApprovalOutboxStatusCounts(),
        ]);
        return {
          enabled: true,
          running: planner.running && dispatcher.running,
          enabledGroupCount: enabledGroups.size,
          planner,
          dispatcher,
          proposals,
          outbox,
        };
      },
      close,
    };
  } catch (error) {
    const cleanup = observeStartupPromise(closeRuntimeResources([
      ...(dispatcherLoop === undefined ? [] : [() => dispatcherLoop!.stop()]),
      ...(plannerLoop === undefined ? [] : [() => plannerLoop!.stop()]),
      ...(pool === undefined ? [] : [() => pool!.end()]),
    ]));
    dependencies.onStartupCleanup?.(cleanup);
    throw error;
  }
}
