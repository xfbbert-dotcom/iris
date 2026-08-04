import { describe, expect, it, vi } from "vitest";

import { RuntimeController } from "../src/admin/runtime-controller.js";
import type { ActionProposalRepository } from "../src/action-approvals/action-proposal-repository.js";
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
    }));
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
    start: vi.fn(),
    getStatus: vi.fn(),
    close: vi.fn(),
  } as KnowledgeCardRuntime;
}

function runtimeDependencies({ order = [] }: { order?: string[] } = {}) {
  const pool = {
    query: vi.fn(),
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
  });
}
