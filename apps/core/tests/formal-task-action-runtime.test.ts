import { describe, expect, it, vi } from "vitest";

import { RuntimeController } from "../src/admin/runtime-controller.js";
import { createDefaultRuntimeConfig } from "../src/config/runtime-config.js";
import {
  createFormalTaskActionRuntime,
  type FormalTaskActionRuntimeDependencies,
} from "../src/runtime/formal-task-action-runtime.js";
import type { FormalTaskExecutionRepository } from
  "../src/formal-tasks/formal-task-execution-repository.js";
import type { KnowledgeCardRuntime } from "../src/runtime/knowledge-card-runtime.js";

describe("FormalTaskActionRuntime", () => {
  it("keeps metadata and recovery available while external creation is default-off", async () => {
    const dependencies = runtimeDependencies();
    const repository = executionRepository();
    const runtime = createFormalTaskActionRuntime({
      env: {},
      runtimeController: controller(),
      executionRepository: repository,
      dependencies,
    });

    expect(runtime).toBeDefined();
    expect(dependencies.createFeishuTenantAccessTokenProvider).not.toHaveBeenCalled();
    expect(dependencies.createFeishuTaskCreator).not.toHaveBeenCalled();
    await runtime!.start();
    await expect(runtime!.getStatus()).resolves.toEqual({
      enabled: true,
      deploymentEnabled: false,
      running: false,
      enabledGroupCount: 0,
      runtimeCreationEnabled: false,
      worker: undefined,
      counts: await repository.getStatusCounts(),
    });
    expect(runtime!.canUseFormalTaskActionsForSourceGroup("oc_pilot")).toBe(false);
    await Promise.all([runtime!.close(), runtime!.close()]);
    expect(dependencies.executionLoop.stop).not.toHaveBeenCalled();
  });

  it("composes the exact one-group executor, reconciler, and result loop with all runtime gates", async () => {
    const order: string[] = [];
    const dependencies = runtimeDependencies({ order });
    const runtimeController = controller();
    runtimeController.setCapability("createFeishuTasks", true);
    runtimeController.setCapability("callExternalTools", true);
    const runtime = createFormalTaskActionRuntime({
      env: enabledEnv(),
      runtimeController,
      executionRepository: executionRepository(),
      knowledgeCardRuntime: knowledgeCardRuntime(dependencies),
      dependencies,
    })!;

    expect(dependencies.createFeishuTenantAccessTokenProvider).toHaveBeenCalledWith({
      baseUrl: "https://open.feishu.cn",
      appId: "app-id",
      appSecret: "app-secret",
    });
    expect(dependencies.createFeishuTaskCreator).toHaveBeenCalledWith(expect.objectContaining({
      baseUrl: "https://open.feishu.cn",
      tokenProvider: dependencies.tokenProvider,
    }));
    const executorInput = dependencies.createExecutor.mock.calls[0]![0];
    expect(executorInput.repository).toBeDefined();
    expect(executorInput.membershipChecker).toBe(dependencies.membershipChecker);
    expect(executorInput.runtimeSnapshot()).toEqual({
      deploymentEnabled: true,
      globalEnabled: true,
      groupAllowlist: ["oc_pilot"],
      disabledGroupIds: [],
      capabilities: { createFeishuTasks: true, callExternalTools: true },
    });
    expect(dependencies.createReconciler).toHaveBeenCalledWith(expect.objectContaining({
      maxAttempts: 4,
      reconciliationDelayMs: 9000,
    }));
    expect(dependencies.createResultDispatcher).toHaveBeenCalledWith(expect.objectContaining({
      cardClient: dependencies.cardClient,
    }));
    const resultDispatcherInput = dependencies.createResultDispatcher.mock.calls[0]![0];
    expect(resultDispatcherInput.canSendResultCards()).toBe(true);
    expect(resultDispatcherInput.canSendResultCards("oc_pilot")).toBe(true);
    expect(resultDispatcherInput.canSendResultCards("oc_other")).toBe(false);
    runtimeController.setCapability("callExternalTools", false);
    expect(resultDispatcherInput.canSendResultCards()).toBe(false);
    expect(resultDispatcherInput.canSendResultCards("oc_pilot")).toBe(false);
    runtimeController.setCapability("callExternalTools", true);
    expect(runtime.canUseFormalTaskActionsForSourceGroup("oc_pilot")).toBe(true);
    expect(runtime.canUseFormalTaskActionsForSourceGroup("oc_other")).toBe(false);

    await runtime.start();
    expect(order).toEqual(["worker-start"]);
    await expect(runtime.getStatus()).resolves.toMatchObject({
      enabled: true,
      deploymentEnabled: true,
      running: true,
      enabledGroupCount: 1,
      runtimeCreationEnabled: true,
      worker: { running: true, intervalMs: 2500, batchLimit: 7 },
    });
    await runtime.close();
    expect(order).toEqual(["worker-start", "worker-stop"]);
  });

  it("fails closed before allocating remote resources when an enabled deployment lacks cards", () => {
    const dependencies = runtimeDependencies();
    expect(() => createFormalTaskActionRuntime({
      env: enabledEnv(),
      runtimeController: controller(),
      executionRepository: executionRepository(),
      dependencies,
    })).toThrow("knowledgeCardRuntime is required when Feishu task creation is enabled");
    expect(dependencies.createFeishuTenantAccessTokenProvider).not.toHaveBeenCalled();
  });
});

function enabledEnv() {
  return {
    IRIS_FEISHU_TASK_CREATION_ENABLED: "true",
    IRIS_FEISHU_TASK_CREATION_GROUP_ALLOWLIST: "oc_pilot",
    IRIS_FEISHU_TASK_CREATION_INTERVAL_MS: "2500",
    IRIS_FEISHU_TASK_CREATION_BATCH_LIMIT: "7",
    IRIS_FEISHU_TASK_CREATION_RECONCILIATION_DELAY_MS: "9000",
    IRIS_FEISHU_TASK_CREATION_MAX_ATTEMPTS: "4",
    FEISHU_APP_ID: "app-id",
    FEISHU_APP_SECRET: "app-secret",
  };
}

function controller() {
  return new RuntimeController(createDefaultRuntimeConfig());
}

function executionRepository(): FormalTaskExecutionRepository {
  return {
    getStatusCounts: vi.fn(async () => ({
      migration0057Applied: true,
      executions: {
        claimed: 0, external_attempting: 0, succeeded: 1, failed: 0,
        outcome_unknown: 0, reconciliation_required: 0,
      },
      results: { pending_send: 0, sent: 1, failed: 0, outcome_unknown: 0 },
      outbox: {
        pending: 0, processing: 0, external_attempting: 0, sent: 1,
        failed: 0, outcome_unknown: 0,
      },
    })),
  } as unknown as FormalTaskExecutionRepository;
}

function knowledgeCardRuntime(
  dependencies: ReturnType<typeof runtimeDependencies>,
): KnowledgeCardRuntime {
  return {
    approvalInteractions: {
      cardClient: dependencies.cardClient,
      membershipChecker: dependencies.membershipChecker,
      botOpenId: "ou_bot",
    },
  } as unknown as KnowledgeCardRuntime;
}

function runtimeDependencies({ order = [] }: { order?: string[] } = {}) {
  const tokenProvider = { getTenantAccessToken: vi.fn() };
  const creator = { createTask: vi.fn(), getTask: vi.fn() };
  const executor = { processBatch: vi.fn() };
  const reconciler = { processBatch: vi.fn() };
  const resultDispatcher = { processBatch: vi.fn() };
  const cardClient = { sendCard: vi.fn(), sendCardToUser: vi.fn(), updateCard: vi.fn() };
  const membershipChecker = { isCurrentMember: vi.fn() };
  const executionLoop = {
    start: vi.fn(() => { order.push("worker-start"); }),
    stop: vi.fn(async () => { order.push("worker-stop"); }),
    isRunning: vi.fn(() => true),
    getSnapshot: vi.fn(() => ({ running: true, intervalMs: 2500, batchLimit: 7 })),
  };
  const dependencies = {
    createFeishuTenantAccessTokenProvider: vi.fn<NonNullable<
      FormalTaskActionRuntimeDependencies["createFeishuTenantAccessTokenProvider"]
    >>(() => tokenProvider as never),
    createFeishuTaskCreator: vi.fn<NonNullable<
      FormalTaskActionRuntimeDependencies["createFeishuTaskCreator"]
    >>(() => creator as never),
    createExecutor: vi.fn<NonNullable<
      FormalTaskActionRuntimeDependencies["createExecutor"]
    >>(() => executor as never),
    createReconciler: vi.fn<NonNullable<
      FormalTaskActionRuntimeDependencies["createReconciler"]
    >>(() => reconciler as never),
    createResultDispatcher: vi.fn<NonNullable<
      FormalTaskActionRuntimeDependencies["createResultDispatcher"]
    >>(() => resultDispatcher as never),
    createExecutionLoop: vi.fn<NonNullable<
      FormalTaskActionRuntimeDependencies["createExecutionLoop"]
    >>(() => executionLoop),
  } satisfies FormalTaskActionRuntimeDependencies;
  return Object.assign(dependencies, {
    tokenProvider, creator, executor, reconciler, resultDispatcher, executionLoop,
    cardClient, membershipChecker,
  });
}
