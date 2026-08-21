import { describe, expect, it, vi } from "vitest";

import { RuntimeController } from "../src/admin/runtime-controller.js";
import type { ActionProposalRepository } from "../src/action-approvals/action-proposal-repository.js";
import type { ManagedKnowledgePageRepository } from
  "../src/action-approvals/managed-knowledge-page-repository.js";
import type { ManagedKnowledgeUpdater } from
  "../src/action-approvals/feishu-managed-knowledge-updater.js";
import type { AgentExecutionObserver } from "../src/agent-runtime/agent-execution-observer.js";
import { createDefaultRuntimeConfig } from "../src/config/runtime-config.js";
import {
  createActionApprovalRuntime,
  type ActionApprovalRuntimeDependencies,
} from "../src/runtime/action-approval-runtime.js";
import type { KnowledgeCardRuntime } from "../src/runtime/knowledge-card-runtime.js";

describe("ActionApprovalRuntime", () => {
  it("allocates no resources while disabled by default", () => {
    const dependencies = runtimeDependencies();

    expect(createActionApprovalRuntime({ env: {}, dependencies })).toBeUndefined();
    expect(dependencies.createPostgresPool).not.toHaveBeenCalled();
  });

  it("requires the shared callback bridge when enabled", () => {
    expect(() => createActionApprovalRuntime({
      env: enabledEnv(),
      runtimeController: enabledController(),
      dependencies: runtimeDependencies(),
    })).toThrow("knowledgeCardRuntime is required when action approvals are enabled");
  });

  it("composes, binds, starts, reports, and closes exact runtime resources", async () => {
    const order: string[] = [];
    const dependencies = runtimeDependencies({ order });
    const knowledgeCards = knowledgeCardRuntime();
    const observe = vi.fn<AgentExecutionObserver["observe"]>(async () => undefined);
    const runtime = createActionApprovalRuntime({
      env: enabledEnv(),
      runtimeController: enabledController(),
      knowledgeCardRuntime: knowledgeCards,
      agentExecutionObserver: { observe },
      dependencies,
    })!;

    expect(dependencies.createPostgresPool).toHaveBeenCalledWith({
      databaseUrl: "postgres://iris:secret@postgres:5432/iris",
    });
    expect(dependencies.createFeishuTenantAccessTokenProvider).toHaveBeenCalledWith({
      baseUrl: "https://open.feishu.cn",
      appId: "app-id",
      appSecret: "app-secret",
    });
    expect(dependencies.createPublicationPublisher).toHaveBeenCalledWith(expect.objectContaining({
      tokenProvider: dependencies.tokenProvider,
    }));
    expect(dependencies.createActionWorker).toHaveBeenCalledWith(expect.objectContaining({
      requireReviewAttestation: false,
      agentExecutionObserver: { observe },
    }));
    expect(dependencies.createPlanner).toHaveBeenCalledWith(expect.objectContaining({
      agentExecutionObserver: { observe },
    }));
    expect(dependencies.createPublicationExecutor).toHaveBeenCalledWith(expect.objectContaining({
      agentExecutionObserver: { observe },
      managedPages: dependencies.managedPageRepository,
    }));
    expect(dependencies.createManagedPageRepository).toHaveBeenCalledWith({
      dataSource: dependencies.pool,
    });
    expect(knowledgeCards.bindActionApprovalWorker).toHaveBeenCalledWith(dependencies.actionWorker);
    const dispatcherGate = dependencies.createDispatcher.mock.calls[0]?.[0].canDeliverApprovalCards;
    expect(dispatcherGate?.("oc_pilot")).toBe(false);
    expect(runtime.canUseActionApprovalsForSourceGroup("oc_pilot")).toBe(false);

    await runtime.start();
    expect(order).toEqual(["planner-start", "dispatcher-start", "publication-start"]);
    expect(runtime.canUseActionApprovalsForSourceGroup("oc_pilot")).toBe(true);
    expect(runtime.canUseActionApprovalsForSourceGroup("oc_other")).toBe(false);
    expect(dispatcherGate?.("oc_pilot")).toBe(true);
    expect(dispatcherGate?.("oc_other")).toBe(false);
    await expect(runtime.getStatus()).resolves.toEqual({
      enabled: true,
      running: true,
      enabledGroupCount: 2,
      planner: { running: true, intervalMs: 1000, batchLimit: 10 },
      dispatcher: { running: true, intervalMs: 1000, batchLimit: 10 },
      publicationExecutor: { running: true, intervalMs: 1000, batchLimit: 10 },
      proposals: {
        pending_approval: 1,
        approved: 2,
        executing: 3,
        succeeded: 4,
        failed: 5,
        cancelled: 6,
        expired: 7,
        reconciliation_required: 8,
      },
      outbox: {
        pending: 1,
        processing: 2,
        external_attempting: 3,
        sent: 4,
        failed: 5,
        outcome_unknown: 6,
        terminalFailed: 7,
      },
    });

    await runtime.close();
    expect(order).toEqual([
      "planner-start",
      "dispatcher-start",
      "publication-start",
      "publication-stop",
      "dispatcher-stop",
      "planner-stop",
      "pool-end",
    ]);
  });

  it("enables the review attestation gate only when explicitly configured", () => {
    const dependencies = runtimeDependencies();
    createActionApprovalRuntime({
      env: { ...enabledEnv(), IRIS_ACTION_REVIEW_ENABLED: "true" },
      runtimeController: enabledController(),
      knowledgeCardRuntime: knowledgeCardRuntime(),
      dependencies,
    });

    expect(dependencies.createActionWorker).toHaveBeenCalledWith(expect.objectContaining({
      requireReviewAttestation: true,
    }));
  });

  it("creates and owns update execution only from an explicit injectable feature snapshot and sync queue", async () => {
    const order: string[] = [];
    const dependencies = runtimeDependencies({ order });
    const runtimeController = enabledController();
    runtimeController.setCapability("writeKnowledgeBase", true);
    runtimeController.setCapability("updateManagedKnowledge", true);
    const syncQueue = { enqueue: vi.fn(async () => undefined) };
    const runtime = createActionApprovalRuntime({
      env: enabledEnv(),
      runtimeController,
      knowledgeCardRuntime: knowledgeCardRuntime(),
      dependencies,
      managedKnowledgeUpdates: {
        deploymentEnabled: true,
        groupAllowlist: ["oc_pilot"],
        activeEmbeddingProfileId: "profile-active",
        syncQueue,
        intervalMs: 2_000,
        batchLimit: 7,
        staleDispatchMs: 60_000,
      },
    })!;

    expect(dependencies.createManagedPageRepository).toHaveBeenCalledWith({
      dataSource: dependencies.pool,
    });
    expect(dependencies.createManagedBlockReader).toHaveBeenCalledWith(expect.objectContaining({
      tokenProvider: dependencies.tokenProvider,
    }));
    expect(dependencies.createManagedUpdater).toHaveBeenCalledWith({
      baseUrl: "https://open.feishu.cn",
      tokenProvider: dependencies.tokenProvider,
      blockReader: dependencies.managedBlockReader,
    });
    expect(dependencies.createManagedUpdateExecutor).toHaveBeenCalledWith(expect.objectContaining({
      proposals: dependencies.repository,
      managedPages: dependencies.managedPageRepository,
      updater: dependencies.managedUpdater,
      permissionVerifier: dependencies.managedMutationPermissionVerifier,
      syncQueue,
    }));
    const runtimeSnapshot = dependencies.createManagedUpdateExecutor.mock.calls[0]?.[0].runtimeSnapshot;
    expect(runtimeSnapshot?.()).toEqual({
      deploymentEnabled: true,
      globalEnabled: true,
      disabledGroupIds: [],
      groupAllowlist: ["oc_pilot"],
      capabilities: { writeKnowledgeBase: true, updateManagedKnowledge: true },
    });
    expect(dependencies.createManagedUpdateReconciler).toHaveBeenCalledWith(expect.objectContaining({
      staleDispatchMs: 60_000,
      activeEmbeddingProfileId: "profile-active",
      permissionVerifier: dependencies.managedMutationPermissionVerifier,
      syncQueue,
    }));
    expect(dependencies.createManagedMutationPermissionVerifier).toHaveBeenCalledWith({
      documentSources: dependencies.documentSourceRegistry,
      permissionChecker: dependencies.documentPermissionChecker,
    });

    await runtime.start();
    expect(order).toEqual([
      "planner-start", "dispatcher-start", "publication-start", "managed-update-start",
    ]);
    await expect(runtime.getStatus()).resolves.toMatchObject({
      managedKnowledgeUpdates: {
        running: true,
        intervalMs: 2_000,
        batchLimit: 7,
        migration0055Applied: true,
        migration0056Applied: true,
        reconciliation: { outcomeUnknown: 0, reconciliationRequired: 0 },
      },
    });
    expect(JSON.stringify((await runtime.getStatus()).managedKnowledgeUpdates)).not.toMatch(
      /body|token|proposalId|executionId/iu,
    );

    await runtime.close();
    expect(order.slice(-5)).toEqual([
      "managed-update-stop", "publication-stop", "dispatcher-stop", "planner-stop", "pool-end",
    ]);
  });

  it("keeps managed-update recovery/admin available while deployment is default-off", async () => {
    const order: string[] = [];
    const dependencies = runtimeDependencies({ order });
    const syncQueue = { enqueue: vi.fn(async () => undefined) };
    const runtime = createActionApprovalRuntime({
      env: enabledEnv(),
      runtimeController: enabledController(),
      knowledgeCardRuntime: knowledgeCardRuntime(),
      dependencies,
      managedKnowledgeUpdates: {
        deploymentEnabled: false,
        groupAllowlist: [],
        activeEmbeddingProfileId: "profile-active",
        syncQueue,
        intervalMs: 2_000,
        batchLimit: 7,
        staleDispatchMs: 60_000,
      },
    })!;

    expect(dependencies.createManagedUpdateExecutor).toHaveBeenCalledOnce();
    expect(dependencies.createManagedUpdateReconciler).toHaveBeenCalledOnce();
    expect(runtime.managedKnowledgeAdmin).toBeDefined();
    expect(dependencies.createManagedUpdateExecutor.mock.calls[0]?.[0].runtimeSnapshot()).toMatchObject({
      deploymentEnabled: false,
      groupAllowlist: [],
    });
    await runtime.start();
    expect(order).toContain("managed-update-start");
    await runtime.close();
  });

  it("does not invoke remote reconciliation again for an exact operator operation replay", async () => {
    const dependencies = runtimeDependencies();
    const claim = {
      execution: {
        id: "execution-1", state: "reconciliation_required", version: 5,
        reconciliationReasonCode: "operator_requested",
      },
    };
    const acknowledgement = {
      executionId: "execution-1", state: "reconciliation_required" as const, version: 5,
      reasonCode: "operator_requested" as const,
    };
    Object.assign(dependencies.managedPageRepository, {
      requestReconciliation: vi.fn()
        .mockResolvedValueOnce({ outcome: "applied", claim, acknowledgement })
        .mockResolvedValueOnce({ outcome: "already_applied", claim, acknowledgement }),
    });
    dependencies.managedUpdateReconciler.reconcileOne.mockResolvedValue({
      executionId: "execution-1", status: "resync_required", code: "readback_confirmed",
    });
    const runtime = createActionApprovalRuntime({
      env: enabledEnv(), runtimeController: enabledController(), knowledgeCardRuntime: knowledgeCardRuntime(), dependencies,
      managedKnowledgeUpdates: {
        deploymentEnabled: true, groupAllowlist: ["oc_pilot"],
        activeEmbeddingProfileId: "profile-active", syncQueue: { enqueue: vi.fn() },
        intervalMs: 2_000, batchLimit: 7, staleDispatchMs: 60_000,
      },
    })!;
    const input = {
      executionId: "execution-1", expectedExecutionVersion: 4, expectedManagedPageVersion: 8,
      operationKey: "managed-update:execution-1:reconcile:4", operator: "operator@example.com", at: new Date(),
    };

    const first = await runtime.managedKnowledgeAdmin!.reconcile(input);
    const replay = await runtime.managedKnowledgeAdmin!.reconcile({
      ...input, at: new Date(input.at.getTime() + 1_000),
    });

    expect(first).toEqual(acknowledgement);
    expect(replay).toEqual(first);
    expect(dependencies.managedUpdateReconciler.reconcileOne).toHaveBeenCalledTimes(1);
  });

  it("does not construct managed-update recovery components without a queue", () => {
    for (const managedKnowledgeUpdates of [
      undefined,
      {
        deploymentEnabled: true,
        groupAllowlist: ["oc_pilot"],
        syncQueue: undefined,
        intervalMs: 2_000,
        batchLimit: 7,
        staleDispatchMs: 60_000,
      },
    ] as const) {
      const dependencies = runtimeDependencies();
      createActionApprovalRuntime({
        env: enabledEnv(),
        runtimeController: enabledController(),
        knowledgeCardRuntime: knowledgeCardRuntime(),
        dependencies,
        ...(managedKnowledgeUpdates === undefined
          ? {}
          : { managedKnowledgeUpdates: managedKnowledgeUpdates as never }),
      });

      expect(dependencies.createManagedBlockReader).not.toHaveBeenCalled();
      expect(dependencies.createManagedUpdater).not.toHaveBeenCalled();
      expect(dependencies.createManagedUpdateLoop).not.toHaveBeenCalled();
    }
  });
});

function enabledEnv() {
  return {
    IRIS_APPROVAL_ACTIONS_ENABLED: "true",
    IRIS_APPROVAL_ACTION_GROUP_IDS: "oc_pilot,oc_review",
    DATABASE_URL: "postgres://iris:secret@postgres:5432/iris",
    FEISHU_APP_ID: "app-id",
    FEISHU_APP_SECRET: "app-secret",
  };
}

function enabledController() {
  return new RuntimeController(createDefaultRuntimeConfig());
}

function knowledgeCardRuntime(): KnowledgeCardRuntime {
  return {
    gateway: { handleCallback: vi.fn() },
    repository: {} as KnowledgeCardRuntime["repository"],
    deadLetters: {
      list: vi.fn(async () => []),
      replay: vi.fn(async () => "not_found" as const),
      delete: vi.fn(async () => "not_found" as const),
    },
    canUseKnowledgeCards: vi.fn(() => true),
    approvalInteractions: {
      cardClient: { updateCard: vi.fn(), sendCardToUser: vi.fn() },
      membershipChecker: { isCurrentMember: vi.fn(async () => true) },
      botOpenId: "ou_irisbot",
    },
    bindActionApprovalWorker: vi.fn(),
    bindKnowledgeConflictInteractionWorker: vi.fn(),
    start: vi.fn(),
    getStatus: vi.fn(),
    close: vi.fn(),
  } as KnowledgeCardRuntime;
}

function runtimeDependencies({ order = [] }: { order?: string[] } = {}) {
  const pool = {
    query: async <T>() => ({
      rows: [{
        migration_0055_present: true,
        migration_0056_present: true,
        outcome_unknown: 0,
        reconciliation_required: 0,
      } as unknown as T],
    }),
    connect: vi.fn(),
    end: vi.fn(async () => { order.push("pool-end"); }),
  };
  const repository = {
    getStatusCounts: vi.fn(async () => ({
      pending_approval: 1,
      approved: 2,
      executing: 3,
      succeeded: 4,
      failed: 5,
      cancelled: 6,
      expired: 7,
      reconciliation_required: 8,
    })),
    getApprovalOutboxStatusCounts: vi.fn(async () => ({
      pending: 1,
      processing: 2,
      external_attempting: 3,
      sent: 4,
      failed: 5,
      outcome_unknown: 6,
      terminalFailed: 7,
    })),
  } as unknown as ActionProposalRepository;
  const plannerLoop = {
    start: vi.fn(() => { order.push("planner-start"); }),
    stop: vi.fn(async () => { order.push("planner-stop"); }),
    isRunning: vi.fn(() => true),
    getSnapshot: vi.fn(() => ({ running: true, intervalMs: 1000, batchLimit: 10 })),
  };
  const dispatcherLoop = {
    start: vi.fn(() => { order.push("dispatcher-start"); }),
    stop: vi.fn(async () => { order.push("dispatcher-stop"); }),
    isRunning: vi.fn(() => true),
    getSnapshot: vi.fn(() => ({ running: true, intervalMs: 1000, batchLimit: 10 })),
  };
  const publicationLoop = {
    start: vi.fn(() => { order.push("publication-start"); }),
    stop: vi.fn(async () => { order.push("publication-stop"); }),
    isRunning: vi.fn(() => true),
    getSnapshot: vi.fn(() => ({ running: true, intervalMs: 1000, batchLimit: 10 })),
  };
  const actionWorker = { processActionApproval: vi.fn() };
  const tokenProvider = { getTenantAccessToken: vi.fn() };
  const publicationPublisher = { publish: vi.fn() };
  const publicationExecutor = { processBatch: vi.fn() };
  const managedPageRepository = {} as ManagedKnowledgePageRepository;
  const managedBlockReader = { readManagedBlock: vi.fn() };
  const managedUpdater = {
    preflight: vi.fn(), update: vi.fn(), readBack: vi.fn(),
  } as unknown as ManagedKnowledgeUpdater;
  const managedUpdateExecutor = { processBatch: vi.fn() };
  const managedUpdateReconciler = { processBatch: vi.fn(), reconcileOne: vi.fn() };
  const managedUpdateLoop = {
    start: vi.fn(() => { order.push("managed-update-start"); }),
    stop: vi.fn(async () => { order.push("managed-update-stop"); }),
    isRunning: vi.fn(() => true),
    getSnapshot: vi.fn(() => ({ running: true, intervalMs: 2_000, batchLimit: 7 })),
  };
  const documentSourceRegistry = { findSourceById: vi.fn() };
  const documentPermissionChecker = { canReadSource: vi.fn() };
  const managedMutationPermissionVerifier = { verify: vi.fn() };
  const dependencies = {
    createPostgresPool: vi.fn(() => pool),
    createRepository: vi.fn(() => repository),
    createPlanner: vi.fn(() => ({ planBatch: vi.fn() })),
    createDispatcher: vi.fn((
      _input: Parameters<NonNullable<ActionApprovalRuntimeDependencies["createDispatcher"]>>[0],
    ) => ({ processBatch: vi.fn() })),
    createActionWorker: vi.fn(() => actionWorker),
    createFeishuTenantAccessTokenProvider: vi.fn(() => tokenProvider),
    createPublicationPublisher: vi.fn(() => publicationPublisher),
    createPublicationExecutor: vi.fn(() => publicationExecutor),
    createPlannerLoop: vi.fn(() => plannerLoop),
    createDispatcherLoop: vi.fn(() => dispatcherLoop),
    createPublicationExecutorLoop: vi.fn(() => publicationLoop),
    createManagedPageRepository: vi.fn<NonNullable<ActionApprovalRuntimeDependencies["createManagedPageRepository"]>>(() => managedPageRepository),
    createManagedBlockReader: vi.fn<NonNullable<ActionApprovalRuntimeDependencies["createManagedBlockReader"]>>(() => managedBlockReader),
    createManagedUpdater: vi.fn<NonNullable<ActionApprovalRuntimeDependencies["createManagedUpdater"]>>(() => managedUpdater),
    createManagedUpdateExecutor: vi.fn<NonNullable<ActionApprovalRuntimeDependencies["createManagedUpdateExecutor"]>>(() => managedUpdateExecutor),
    createManagedUpdateReconciler: vi.fn<NonNullable<ActionApprovalRuntimeDependencies["createManagedUpdateReconciler"]>>(() => managedUpdateReconciler),
    createManagedUpdateLoop: vi.fn<NonNullable<ActionApprovalRuntimeDependencies["createManagedUpdateLoop"]>>(() => managedUpdateLoop),
    createDocumentSourceRegistry: vi.fn(() => documentSourceRegistry as never),
    createDocumentPermissionChecker: vi.fn(() => documentPermissionChecker),
    createManagedMutationPermissionVerifier: vi.fn(() => managedMutationPermissionVerifier),
  } satisfies ActionApprovalRuntimeDependencies;
  return Object.assign(dependencies, {
    pool,
    repository,
    plannerLoop,
    dispatcherLoop,
    publicationLoop,
    actionWorker,
    tokenProvider,
    publicationPublisher,
    publicationExecutor,
    managedPageRepository,
    managedBlockReader,
    managedUpdater,
    managedUpdateExecutor,
    managedUpdateReconciler,
    managedUpdateLoop,
    documentSourceRegistry,
    documentPermissionChecker,
    managedMutationPermissionVerifier,
  });
}
