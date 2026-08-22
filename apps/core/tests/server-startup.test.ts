import { createServer, type Server } from "node:net";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

import {
  buildApp,
  startServer,
  type BuildAppDependencies,
} from "../src/app.js";
import {
  createInMemoryRuntimeControlService,
} from "../src/admin/runtime-control-service.js";
import { RuntimeController } from "../src/admin/runtime-controller.js";
import { createDefaultRuntimeConfig } from "../src/config/runtime-config.js";
import type { EventWorkerRuntime } from "../src/runtime/event-worker-runtime.js";
import type { ActionApprovalRuntime } from "../src/runtime/action-approval-runtime.js";
import type { ActionReviewRuntime } from "../src/runtime/action-review-runtime.js";
import type { MemoryExtractionRuntime } from "../src/runtime/memory-extraction-runtime.js";
import type {
  ProactiveSignalRepository,
  ProactiveSignalRuntime,
} from "../src/proactive-signals/proactive-signal-repository.js";
import type { ProactiveSignalDeliveryRuntime } from "../src/runtime/proactive-signal-delivery-runtime.js";
import type { ProactiveSignalPlannerRuntime } from "../src/runtime/proactive-signal-planner-runtime.js";
import type { ReindexWorkerRuntime } from "../src/runtime/reindex-worker-runtime.js";
import type { RuntimeControlRuntime } from "../src/runtime/runtime-control-runtime.js";
import type { KnowledgeCardRuntime } from "../src/runtime/knowledge-card-runtime.js";
import type { KnowledgeDraftRuntime } from "../src/runtime/knowledge-draft-runtime.js";
import type { FormalTaskRuntime } from "../src/runtime/formal-task-runtime.js";
import type { AnswerDraftRuntime } from "../src/runtime/answer-draft-runtime.js";
import type { KnowledgeConflictRuntime } from "../src/runtime/knowledge-conflict-runtime.js";
import type { AnswerSourcePermissionVerifier } from "../src/answer-replies/answer-source-permission-verifier.js";
import { isolateEnvVar } from "./test-env.js";

let restorePort: () => void = () => undefined;
let restoreInternalApiToken: () => void = () => undefined;
let restoreFeishuVerificationToken: () => void = () => undefined;
let restoreIngressHealthToken: () => void = () => undefined;
let occupiedServer: Server | undefined;

beforeEach(() => {
  restorePort = isolateEnvVar("PORT");
  restoreInternalApiToken = isolateEnvVar("IRIS_INTERNAL_API_TOKEN");
  restoreFeishuVerificationToken = isolateEnvVar("FEISHU_VERIFICATION_TOKEN");
  restoreIngressHealthToken = isolateEnvVar("IRIS_INGRESS_HEALTH_TOKEN");
});

afterEach(async () => {
  await closeServer(occupiedServer);
  occupiedServer = undefined;
  restoreIngressHealthToken();
  restoreFeishuVerificationToken();
  restoreInternalApiToken();
  restorePort();
});

describe("Core server startup", () => {
  it("fails closed during composition for a malformed managed-update deployment flag", async () => {
    const createActionApprovalRuntime = vi.fn(() => undefined);

    await expect(buildApp({
      readinessEnv: { IRIS_MANAGED_KNOWLEDGE_UPDATE_ENABLED: "enabled" },
      createAnswerDraftRuntime: () => undefined,
      createEventWorkerRuntime: () => undefined,
      createDocumentSyncRuntime: () => undefined,
      createReindexWorkerRuntime: () => undefined,
      createActionApprovalRuntime,
    })).rejects.toThrow("IRIS_MANAGED_KNOWLEDGE_UPDATE_ENABLED must be true or false");

    expect(createActionApprovalRuntime).not.toHaveBeenCalled();
  });

  it("reports an enabled managed-update deployment without its worker dependency as not ready", async () => {
    const app = await buildApp({
      readinessEnv: {
        IRIS_MANAGED_KNOWLEDGE_UPDATE_ENABLED: "true",
        IRIS_MANAGED_KNOWLEDGE_UPDATE_GROUP_ALLOWLIST: "oc_pilot",
      },
      createAnswerDraftRuntime: () => undefined,
      createEventWorkerRuntime: () => undefined,
      createDocumentSyncRuntime: () => undefined,
      createReindexWorkerRuntime: () => undefined,
      createActionApprovalRuntime: () => undefined,
    });

    const readiness = (await app.inject({ method: "GET", url: "/internal/readiness" })).json();

    expect(readiness).toMatchObject({ ok: false, status: "blocked" });
    expect(readiness.checks).toContainEqual(expect.objectContaining({
      id: "managedKnowledgeUpdates", status: "fail",
    }));
    await app.close();
  });

  it("wires the governed chat knowledge-draft command into the event worker", async () => {
    const answerDraftRuntime: AnswerDraftRuntime = {
      answerDraftOrchestrator: { generateDraft: vi.fn() },
      answerSourcePermissionVerifier: { verify: vi.fn(async () => []) },
      chatKnowledgeDraftGenerator: {
        generate: vi.fn(async () => ({ status: "no_context" as const })),
      },
      chatFormalTaskDraftGenerator: {
        generate: vi.fn(async () => ({ status: "no_context" as const })),
      },
      close: vi.fn(async () => undefined),
    };
    const knowledgeDraftRuntime: KnowledgeDraftRuntime = {
      repository: {} as KnowledgeDraftRuntime["repository"],
      canCreateDraft: vi.fn(() => true),
      getStatus: vi.fn(),
      close: vi.fn(async () => undefined),
    };
    const knowledgeCardRuntime = fakeKnowledgeCardRuntime();
    const formalTaskRuntime: FormalTaskRuntime = {
      repository: {} as FormalTaskRuntime["repository"],
      cardRepository: {} as FormalTaskRuntime["cardRepository"],
      canUseFormalTaskCards: () => false,
      presentDraft: vi.fn(),
      canCreateDraft: vi.fn(() => true),
      getStatus: vi.fn(),
      close: vi.fn(async () => undefined),
    };
    const actionApprovalRuntime = fakeActionApprovalRuntime();
    let capturedAnswerSourcePermissionVerifier: AnswerSourcePermissionVerifier | undefined;
    const createEventWorkerRuntime = vi.fn<NonNullable<
      BuildAppDependencies["createEventWorkerRuntime"]
    >>((input) => {
      capturedAnswerSourcePermissionVerifier = input?.answerSourcePermissionVerifier;
      return undefined;
    });
    const app = await buildApp({
      createAgentExecutionLedgerRuntime: () => undefined,
      createAnswerDraftRuntime: () => answerDraftRuntime,
      createReindexWorkerRuntime: () => undefined,
      createMemoryExtractionRuntime: () => undefined,
      createConversationStateInspectionRuntime: () => undefined,
      createProactiveSignalRuntime: () => undefined,
      createKnowledgeDraftRuntime: () => knowledgeDraftRuntime,
      createFormalTaskRuntime: () => formalTaskRuntime,
      createKnowledgeCardRuntime: () => knowledgeCardRuntime,
      createActionApprovalRuntime: () => actionApprovalRuntime,
      createActionReviewRuntime: () => undefined,
      createProactiveSignalPlannerRuntime: () => undefined,
      createProactiveSignalDeliveryRuntime: () => undefined,
      createEventWorkerRuntime,
      createDocumentSyncRuntime: () => undefined,
    });

    expect(createEventWorkerRuntime).toHaveBeenCalledWith(expect.objectContaining({
      answerDraftOrchestrator: answerDraftRuntime.answerDraftOrchestrator,
      answerSourcePermissionVerifier: answerDraftRuntime.answerSourcePermissionVerifier,
      knowledgeDraftCommand: expect.objectContaining({ execute: expect.any(Function) }),
      formalTaskDraftCommand: expect.objectContaining({ execute: expect.any(Function) }),
    }));
    expect(capturedAnswerSourcePermissionVerifier).toBe(
      answerDraftRuntime.answerSourcePermissionVerifier,
    );
    await app.close();
  });

  it("projects content-free formal task draft status and readiness while creation is disabled", async () => {
    const formalTaskRuntime: FormalTaskRuntime = {
      repository: {} as FormalTaskRuntime["repository"],
      cardRepository: {} as FormalTaskRuntime["cardRepository"],
      canUseFormalTaskCards: () => false,
      presentDraft: vi.fn(),
      canCreateDraft: vi.fn(() => false),
      getStatus: vi.fn(async () => ({
        enabled: true as const,
        companyCreationEnabled: false,
        counts: {
          pending_confirmation: 2,
          pending_review: 1,
          needs_revision: 3,
          rejected: 4,
          created: 5,
        },
      })),
      close: vi.fn(async () => undefined),
    };
    const app = await buildApp({
      createAnswerDraftRuntime: () => undefined,
      createFormalTaskRuntime: () => formalTaskRuntime,
      createEventWorkerRuntime: () => undefined,
      createDocumentSyncRuntime: () => undefined,
      createReindexWorkerRuntime: () => undefined,
      createKnowledgeCardRuntime: () => undefined,
      createActionApprovalRuntime: () => undefined,
      createActionReviewRuntime: () => undefined,
      createProactiveSignalPlannerRuntime: () => undefined,
      createProactiveSignalDeliveryRuntime: () => undefined,
    });

    const status = (await app.inject({ method: "GET", url: "/internal/status" })).json();
    expect(status.components.formalTaskDrafts).toEqual({
      status: "disabled",
      ok: true,
      enabled: false,
      companyCreationEnabled: false,
      counts: {
        pending_confirmation: 2,
        pending_review: 1,
        needs_revision: 3,
        rejected: 4,
        created: 5,
      },
    });

    const readiness = (await app.inject({ method: "GET", url: "/internal/readiness" })).json();
    expect(readiness.checks).toContainEqual(expect.objectContaining({
      id: "formalTaskDrafts",
      status: "pass",
      detail: "Formal task draft generation is safely disabled.",
    }));
    await app.close();
  });

  it("does not expose or start the app before async event runtime construction settles", async () => {
    const eventWorkerRuntime = fakeEventWorkerRuntime({
      start: vi.fn(),
    });
    let resolveConstruction: (
      runtime: EventWorkerRuntime | undefined,
    ) => void = () => undefined;
    const pendingConstruction = new Promise<EventWorkerRuntime | undefined>((resolve) => {
      resolveConstruction = resolve;
    });
    const createEventWorkerRuntime: NonNullable<
      BuildAppDependencies["createEventWorkerRuntime"]
    > = () => pendingConstruction;
    let settled = false;

    const appConstruction = buildApp({
      createAgentExecutionLedgerRuntime: () => undefined,
      createAnswerDraftRuntime: () => undefined,
      createReindexWorkerRuntime: () => undefined,
      createMemoryExtractionRuntime: () => undefined,
      createConversationStateInspectionRuntime: () => undefined,
      createProactiveSignalRuntime: () => undefined,
      createKnowledgeDraftRuntime: () => undefined,
      createKnowledgeCardRuntime: () => undefined,
      createActionApprovalRuntime: () => undefined,
      createActionReviewRuntime: () => undefined,
      createProactiveSignalPlannerRuntime: () => undefined,
      createProactiveSignalDeliveryRuntime: () => undefined,
      createEventWorkerRuntime,
      createDocumentSyncRuntime: () => undefined,
    });
    void Promise.resolve(appConstruction).then(
      () => { settled = true; },
      () => { settled = true; },
    );

    await Promise.resolve();
    expect(settled).toBe(false);
    expect(eventWorkerRuntime.start).not.toHaveBeenCalled();

    resolveConstruction(eventWorkerRuntime);
    const app = await appConstruction;
    expect(eventWorkerRuntime.start).toHaveBeenCalledOnce();
    await app.close();
  });

  it("rejects an invalid port before creating runtime resources", async () => {
    process.env.PORT = "65536";
    process.env.IRIS_INTERNAL_API_TOKEN = "operator-secret";
    process.env.FEISHU_VERIFICATION_TOKEN = "verification-secret";
    const createAnswerDraftRuntime = vi.fn(() => undefined);
    const createEventWorkerRuntime = vi.fn(() => undefined);
    const createDocumentSyncRuntime = vi.fn(() => undefined);
    const createReindexWorkerRuntime = vi.fn(() => undefined);
    const createRuntimeControlRuntime = vi.fn(async () => fakeRuntimeControlRuntime());

    await expect(
      startServer({
        createRuntimeControlRuntime,
        appDependencies: {
          createAnswerDraftRuntime,
          createEventWorkerRuntime,
          createDocumentSyncRuntime,
          createReindexWorkerRuntime,
        },
      }),
    ).rejects.toThrow("PORT must be between 1 and 65535");

    expect(createAnswerDraftRuntime).not.toHaveBeenCalled();
    expect(createEventWorkerRuntime).not.toHaveBeenCalled();
    expect(createDocumentSyncRuntime).not.toHaveBeenCalled();
    expect(createReindexWorkerRuntime).not.toHaveBeenCalled();
    expect(createRuntimeControlRuntime).not.toHaveBeenCalled();
  });

  it.each([
    ["IRIS_INTERNAL_API_TOKEN", "operator secret"],
    ["IRIS_INGRESS_HEALTH_TOKEN", "ingress secret"],
  ])("rejects invalid %s auth before creating database resources", async (name, value) => {
    process.env[name] = value;
    const createRuntimeControlRuntime = vi.fn(async () => fakeRuntimeControlRuntime());

    await expect(startServer({ createRuntimeControlRuntime })).rejects.toThrow(
      `${name} must be a single bearer token`,
    );

    expect(createRuntimeControlRuntime).not.toHaveBeenCalled();
  });

  it("does not build workers or listen when durable runtime state fails to load", async () => {
    const durableStateError = new Error("postgres unavailable");
    const createRuntimeControlRuntime = vi.fn(async () => {
      throw durableStateError;
    });
    const createAnswerDraftRuntime = vi.fn(() => undefined);
    const createEventWorkerRuntime = vi.fn(() => undefined);
    const createDocumentSyncRuntime = vi.fn(() => undefined);
    const createReindexWorkerRuntime = vi.fn(() => undefined);

    await expect(startServer({
      createRuntimeControlRuntime,
      appDependencies: {
        createAnswerDraftRuntime,
        createEventWorkerRuntime,
        createDocumentSyncRuntime,
        createReindexWorkerRuntime,
      },
    })).rejects.toBe(durableStateError);

    expect(createRuntimeControlRuntime).toHaveBeenCalledOnce();
    expect(createAnswerDraftRuntime).not.toHaveBeenCalled();
    expect(createEventWorkerRuntime).not.toHaveBeenCalled();
    expect(createDocumentSyncRuntime).not.toHaveBeenCalled();
    expect(createReindexWorkerRuntime).not.toHaveBeenCalled();
  });

  it("returns a listening app that closes runtime resources normally", async () => {
    const reservation = await occupyLoopbackPort();
    const port = reservation.port;
    await closeServer(reservation.server);
    process.env.PORT = String(port);
    const eventWorkerRuntime = fakeEventWorkerRuntime();
    const runtimeControlRuntime = fakeRuntimeControlRuntime();

    const app = await startServer({
      createRuntimeControlRuntime: async () => runtimeControlRuntime,
      appDependencies: {
        createAnswerDraftRuntime: () => undefined,
        createEventWorkerRuntime: () => eventWorkerRuntime,
        createDocumentSyncRuntime: () => undefined,
        createReindexWorkerRuntime: () => undefined,
      },
    });

    try {
      expect(app.server.listening).toBe(true);
      expect(eventWorkerRuntime.start).toHaveBeenCalledOnce();
    } finally {
      await app.close();
    }

    expect(app.server.listening).toBe(false);
    expect(eventWorkerRuntime.close).toHaveBeenCalledOnce();
    expect(runtimeControlRuntime.close).toHaveBeenCalledOnce();
    expect(vi.mocked(eventWorkerRuntime.close).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(runtimeControlRuntime.close).mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("starts extraction before the event runtime, injects its planner, and closes in reverse order", async () => {
    const reservation = await occupyLoopbackPort();
    const port = reservation.port;
    await closeServer(reservation.server);
    process.env.PORT = String(port);
    const order: string[] = [];
    const extractionRuntime = fakeMemoryExtractionRuntime({
      start: vi.fn(() => order.push("start-extraction")),
      close: vi.fn(async () => {
        order.push("close-extraction");
      }),
    });
    const eventWorkerRuntime = fakeEventWorkerRuntime({
      start: vi.fn(() => order.push("start-event")),
      close: vi.fn(async () => {
        order.push("close-event");
      }),
    });
    const runtimeControlRuntime = fakeRuntimeControlRuntime({
      onClose: () => order.push("close-runtime-control"),
    });
    const createMemoryExtractionRuntime = vi.fn(() => {
      order.push("create-extraction");
      return extractionRuntime;
    });
    const createEventWorkerRuntime = vi.fn((input) => {
      order.push("create-event");
      expect(input).toEqual({
        runtimeController: runtimeControlRuntime.runtimeControl.controller,
        memoryExtractionPlanner: extractionRuntime.planner,
      });
      return eventWorkerRuntime;
    });

    const app = await startServer({
      createRuntimeControlRuntime: async () => runtimeControlRuntime,
      appDependencies: {
        createAnswerDraftRuntime: () => undefined,
        createReindexWorkerRuntime: () => undefined,
        createMemoryExtractionRuntime,
        createEventWorkerRuntime,
        createDocumentSyncRuntime: () => undefined,
      },
    });

    expect(order).toEqual([
      "create-extraction",
      "start-extraction",
      "create-event",
      "start-event",
    ]);
    await app.close();
    expect(order).toEqual([
      "create-extraction",
      "start-extraction",
      "create-event",
      "start-event",
      "close-event",
      "close-extraction",
      "close-runtime-control",
    ]);
  });

  it("starts knowledge cards with the durable controller and closes them after event workers", async () => {
    const reservation = await occupyLoopbackPort();
    const port = reservation.port;
    await closeServer(reservation.server);
    process.env.PORT = String(port);
    const order: string[] = [];
    const runtimeControlRuntime = fakeRuntimeControlRuntime({
      onClose: () => order.push("close-runtime-control"),
    });
    const proactiveSignalRepository = {} as ProactiveSignalRepository;
    const knowledgeCardRuntime = fakeKnowledgeCardRuntime({
      start: vi.fn(async () => {
        order.push("start-knowledge-cards");
      }),
      close: vi.fn(async () => {
        order.push("close-knowledge-cards");
      }),
    });
    const actionApprovalRuntime = fakeActionApprovalRuntime({
      start: vi.fn(async () => {
        order.push("start-action-approvals");
      }),
      close: vi.fn(async () => {
        order.push("close-action-approvals");
      }),
    });
    const actionReviewRuntime = fakeActionReviewRuntime({
      close: vi.fn(async () => {
        order.push("close-action-reviews");
      }),
    });
    const eventWorkerRuntime = fakeEventWorkerRuntime({
      start: vi.fn(() => order.push("start-event")),
      close: vi.fn(async () => {
        order.push("close-event");
      }),
    });
    const createKnowledgeCardRuntime = vi.fn((input) => {
      expect(input).toEqual({
        runtimeController: runtimeControlRuntime.runtimeControl.controller,
        proactiveSignalRepository,
      });
      return knowledgeCardRuntime;
    });
    const createActionApprovalRuntime = vi.fn((input) => {
      expect(input).toEqual({
        runtimeController: runtimeControlRuntime.runtimeControl.controller,
        knowledgeCardRuntime,
      });
      return actionApprovalRuntime;
    });
    const createActionReviewRuntime = vi.fn((input) => {
      expect(input).toEqual({ actionApprovalRuntime });
      return actionReviewRuntime;
    });

    const app = await startServer({
      createRuntimeControlRuntime: async () => runtimeControlRuntime,
      appDependencies: {
        createAnswerDraftRuntime: () => undefined,
        createReindexWorkerRuntime: () => undefined,
        createMemoryExtractionRuntime: () => undefined,
        createKnowledgeDraftRuntime: () => undefined,
        proactiveSignalRepository,
        createKnowledgeCardRuntime,
        createActionApprovalRuntime,
        createActionReviewRuntime,
        createEventWorkerRuntime: () => eventWorkerRuntime,
        createDocumentSyncRuntime: () => undefined,
      },
    });

    expect(order).toEqual(["start-knowledge-cards", "start-action-approvals", "start-event"]);
    await app.close();
    expect(order).toEqual([
      "start-knowledge-cards",
      "start-action-approvals",
      "start-event",
      "close-event",
      "close-action-reviews",
      "close-knowledge-cards",
      "close-action-approvals",
      "close-runtime-control",
    ]);
    expect(createKnowledgeCardRuntime).toHaveBeenCalledOnce();
    expect(createActionApprovalRuntime).toHaveBeenCalledOnce();
    expect(createActionReviewRuntime).toHaveBeenCalledOnce();
  });

  it("closes knowledge cards before their runtime-owned proactive repository", async () => {
    const order: string[] = [];
    const runtimeController = new RuntimeController(createDefaultRuntimeConfig());
    const proactiveSignalRepository = {} as ProactiveSignalRepository;
    const proactiveSignalRuntime: ProactiveSignalRuntime = {
      repository: proactiveSignalRepository,
      close: vi.fn(async () => {
        order.push("close-proactive-signals");
      }),
    };
    const knowledgeCardRuntime = fakeKnowledgeCardRuntime({
      close: vi.fn(async () => {
        order.push("close-knowledge-cards");
      }),
    });
    const createKnowledgeCardRuntime = vi.fn(() => knowledgeCardRuntime);
    const app = await buildApp({
      runtimeController,
      createProactiveSignalRuntime: () => proactiveSignalRuntime,
      createKnowledgeCardRuntime,
      createAnswerDraftRuntime: () => undefined,
      createAgentExecutionLedgerRuntime: () => undefined,
      createReindexWorkerRuntime: () => undefined,
      createMemoryExtractionRuntime: () => undefined,
      createKnowledgeDraftRuntime: () => undefined,
      createActionApprovalRuntime: () => undefined,
      createActionReviewRuntime: () => undefined,
      createProactiveSignalPlannerRuntime: () => undefined,
      createProactiveSignalDeliveryRuntime: () => undefined,
      createEventWorkerRuntime: () => undefined,
      createDocumentSyncRuntime: () => undefined,
    });

    expect(createKnowledgeCardRuntime).toHaveBeenCalledWith({
      runtimeController,
      proactiveSignalRepository,
    });

    await app.close();
    expect(order).toEqual(["close-knowledge-cards", "close-proactive-signals"]);
    expect(knowledgeCardRuntime.close).toHaveBeenCalledOnce();
    expect(proactiveSignalRuntime.close).toHaveBeenCalledOnce();
  });

  it("starts proactive signal delivery after approvals and before event workers", async () => {
    const reservation = await occupyLoopbackPort();
    const port = reservation.port;
    await closeServer(reservation.server);
    process.env.PORT = String(port);
    const order: string[] = [];
    const runtimeControlRuntime = fakeRuntimeControlRuntime({
      onClose: () => order.push("close-runtime-control"),
    });
    const actionApprovalRuntime = fakeActionApprovalRuntime({
      start: vi.fn(async () => {
        order.push("start-action-approvals");
      }),
      close: vi.fn(async () => {
        order.push("close-action-approvals");
      }),
    });
    const proactiveRuntime = fakeProactiveSignalDeliveryRuntime({
      start: vi.fn(async () => {
        order.push("start-proactive-signals");
      }),
      close: vi.fn(async () => {
        order.push("close-proactive-signals");
      }),
    });
    const knowledgeCardRuntime = fakeKnowledgeCardRuntime({
      start: vi.fn(async () => {
        order.push("start-knowledge-cards");
      }),
      close: vi.fn(async () => {
        order.push("close-knowledge-cards");
      }),
    });
    const eventWorkerRuntime = fakeEventWorkerRuntime({
      start: vi.fn(() => order.push("start-event")),
      close: vi.fn(async () => {
        order.push("close-event");
      }),
    });
    const createProactiveSignalDeliveryRuntime = vi.fn((input) => {
      expect(input).toEqual({ runtimeController: runtimeControlRuntime.runtimeControl.controller });
      return proactiveRuntime;
    });

    const app = await startServer({
      createRuntimeControlRuntime: async () => runtimeControlRuntime,
      appDependencies: {
        createAnswerDraftRuntime: () => undefined,
        createReindexWorkerRuntime: () => undefined,
        createMemoryExtractionRuntime: () => undefined,
        createKnowledgeDraftRuntime: () => undefined,
        createKnowledgeCardRuntime: () => knowledgeCardRuntime,
        createActionApprovalRuntime: () => actionApprovalRuntime,
        createActionReviewRuntime: () => undefined,
        createProactiveSignalDeliveryRuntime,
        createEventWorkerRuntime: () => eventWorkerRuntime,
        createDocumentSyncRuntime: () => undefined,
      },
    });

    expect(order).toEqual([
      "start-knowledge-cards",
      "start-action-approvals",
      "start-proactive-signals",
      "start-event",
    ]);
    await app.close();
    expect(order).toEqual([
      "start-knowledge-cards",
      "start-action-approvals",
      "start-proactive-signals",
      "start-event",
      "close-event",
      "close-proactive-signals",
      "close-knowledge-cards",
      "close-action-approvals",
      "close-runtime-control",
    ]);
    expect(createProactiveSignalDeliveryRuntime).toHaveBeenCalledOnce();
  });

  it("fails closed before starting proactive delivery when its feedback runtime is unavailable", async () => {
    const proactiveRuntime = fakeProactiveSignalDeliveryRuntime();
    let cleanup: Promise<void> | undefined;
    let app: FastifyInstance | undefined;
    let startupError: unknown;
    try {
      app = await buildApp({
        createAnswerDraftRuntime: () => undefined,
        createAgentExecutionLedgerRuntime: () => undefined,
        createReindexWorkerRuntime: () => undefined,
        createMemoryExtractionRuntime: () => undefined,
        createKnowledgeDraftRuntime: () => undefined,
        createKnowledgeCardRuntime: () => undefined,
        createActionApprovalRuntime: () => undefined,
        createActionReviewRuntime: () => undefined,
        createProactiveSignalPlannerRuntime: () => undefined,
        createProactiveSignalDeliveryRuntime: () => proactiveRuntime,
        createEventWorkerRuntime: () => undefined,
        createDocumentSyncRuntime: () => undefined,
        onRuntimeStartupCleanup: (pendingCleanup) => {
          cleanup = pendingCleanup;
        },
      });
    } catch (error) {
      startupError = error;
    } finally {
      await app?.close();
    }

    await cleanup;
    expect(startupError).toEqual(
      new Error("proactive signal delivery requires the knowledge-card feedback runtime"),
    );
    expect(proactiveRuntime.start).not.toHaveBeenCalled();
    expect(proactiveRuntime.close).toHaveBeenCalledOnce();
  });

  it("starts proactive signal planner before delivery and event workers", async () => {
    const reservation = await occupyLoopbackPort();
    const port = reservation.port;
    await closeServer(reservation.server);
    process.env.PORT = String(port);
    const order: string[] = [];
    const runtimeControlRuntime = fakeRuntimeControlRuntime({
      onClose: () => order.push("close-runtime-control"),
    });
    const proactivePlannerRuntime = fakeProactiveSignalPlannerRuntime({
      start: vi.fn(async () => {
        order.push("start-proactive-planner");
      }),
      close: vi.fn(async () => {
        order.push("close-proactive-planner");
      }),
    });
    const proactiveDeliveryRuntime = fakeProactiveSignalDeliveryRuntime({
      start: vi.fn(async () => {
        order.push("start-proactive-delivery");
      }),
      close: vi.fn(async () => {
        order.push("close-proactive-delivery");
      }),
    });
    const knowledgeCardRuntime = fakeKnowledgeCardRuntime({
      start: vi.fn(async () => {
        order.push("start-knowledge-cards");
      }),
      close: vi.fn(async () => {
        order.push("close-knowledge-cards");
      }),
    });
    const eventWorkerRuntime = fakeEventWorkerRuntime({
      start: vi.fn(() => order.push("start-event")),
      close: vi.fn(async () => {
        order.push("close-event");
      }),
    });
    const conversationStateInspectionStore = fakeConversationStateInspectionStore();
    const createProactiveSignalPlannerRuntime = vi.fn((input) => {
      expect(input?.runtimeController).toBe(runtimeControlRuntime.runtimeControl.controller);
      expect(input?.store).toBe(conversationStateInspectionStore);
      return proactivePlannerRuntime;
    });

    const app = await startServer({
      createRuntimeControlRuntime: async () => runtimeControlRuntime,
      appDependencies: {
        createAnswerDraftRuntime: () => undefined,
        createReindexWorkerRuntime: () => undefined,
        createMemoryExtractionRuntime: () => undefined,
        createKnowledgeDraftRuntime: () => undefined,
        createKnowledgeCardRuntime: () => knowledgeCardRuntime,
        createActionApprovalRuntime: () => undefined,
        createActionReviewRuntime: () => undefined,
        conversationStateInspectionStore,
        createProactiveSignalPlannerRuntime,
        createProactiveSignalDeliveryRuntime: () => proactiveDeliveryRuntime,
        createEventWorkerRuntime: () => eventWorkerRuntime,
        createDocumentSyncRuntime: () => undefined,
      },
    });

    expect(order).toEqual([
      "start-knowledge-cards",
      "start-proactive-planner",
      "start-proactive-delivery",
      "start-event",
    ]);
    await app.close();
    expect(order).toEqual([
      "start-knowledge-cards",
      "start-proactive-planner",
      "start-proactive-delivery",
      "start-event",
      "close-event",
      "close-proactive-delivery",
      "close-proactive-planner",
      "close-knowledge-cards",
      "close-runtime-control",
    ]);
    expect(createProactiveSignalPlannerRuntime).toHaveBeenCalledOnce();
  });

  it("surfaces a rejected knowledge-card startup through buildApp readiness and closes once", async () => {
    const startError = new Error("knowledge-card startup failed");
    const startup = Promise.reject(startError);
    void startup.catch(() => undefined);
    const knowledgeCardRuntime = fakeKnowledgeCardRuntime({
      start: vi.fn(() => startup),
      close: vi.fn(async () => undefined),
    });
    const app = await buildApp({
      createAnswerDraftRuntime: () => undefined,
      createReindexWorkerRuntime: () => undefined,
      createMemoryExtractionRuntime: () => undefined,
      createKnowledgeDraftRuntime: () => undefined,
      createKnowledgeCardRuntime: () => knowledgeCardRuntime,
      createEventWorkerRuntime: () => undefined,
      createDocumentSyncRuntime: () => undefined,
    });

    let readyError: unknown;
    try {
      await app.ready();
    } catch (error) {
      readyError = error;
    } finally {
      await app.close();
    }
    expect(readyError).toBe(startError);
    expect(knowledgeCardRuntime.start).toHaveBeenCalledOnce();
    expect(knowledgeCardRuntime.close).toHaveBeenCalledOnce();
  });

  it("wires conflicts before answers, binds callbacks, and starts after cards and approvals", async () => {
    const order: string[] = [];
    const knowledgeCardRuntime = fakeKnowledgeCardRuntime({
      start: vi.fn(async () => { order.push("cards"); }),
      close: vi.fn(async () => { order.push("close-cards"); }),
    });
    const actionApprovalRuntime = fakeActionApprovalRuntime({
      start: vi.fn(async () => { order.push("approvals"); }),
      close: vi.fn(async () => { order.push("close-approvals"); }),
    });
    const knowledgeConflictRuntime = fakeKnowledgeConflictRuntime({
      start: vi.fn(async () => { order.push("conflicts"); }),
      close: vi.fn(async () => { order.push("close-conflicts"); }),
    });
    let presentationGetter: (() => unknown) | undefined;
    const createKnowledgeConflictRuntime = vi.fn<NonNullable<
      BuildAppDependencies["createKnowledgeConflictRuntime"]
    >>((input) => {
      presentationGetter = input.getKnowledgeCardPresentationRuntime;
      expect(presentationGetter()).toBeUndefined();
      return knowledgeConflictRuntime;
    });
    const createAnswerDraftRuntime = vi.fn(() => undefined);

    const app = await buildApp({
      createKnowledgeConflictRuntime,
      createAnswerDraftRuntime,
      createReindexWorkerRuntime: () => undefined,
      createMemoryExtractionRuntime: () => undefined,
      createKnowledgeDraftRuntime: () => undefined,
      createKnowledgeCardRuntime: () => knowledgeCardRuntime,
      createActionApprovalRuntime: () => actionApprovalRuntime,
      createActionReviewRuntime: () => undefined,
      createProactiveSignalPlannerRuntime: () => undefined,
      createProactiveSignalDeliveryRuntime: () => undefined,
      createEventWorkerRuntime: () => undefined,
      createDocumentSyncRuntime: () => undefined,
    });
    await app.ready();

    expect(createKnowledgeConflictRuntime).toHaveBeenCalledOnce();
    expect(createAnswerDraftRuntime).toHaveBeenCalledWith(expect.objectContaining({
      knowledgeConflictAnswerProvider: knowledgeConflictRuntime.answerProvider,
    }));
    expect(knowledgeCardRuntime.bindKnowledgeConflictInteractionWorker).toHaveBeenCalledWith(
      knowledgeConflictRuntime.interactionWorker,
    );
    expect(presentationGetter?.()).toBe(knowledgeCardRuntime);
    expect(order).toEqual(["cards", "approvals", "conflicts"]);

    await app.close();
    expect(order).toEqual([
      "cards", "approvals", "conflicts",
      "close-cards", "close-conflicts", "close-approvals",
    ]);
  });

  it("drains an in-flight conflict callback before closing conflict resources", async () => {
    const callbackRelease = deferred<void>();
    const callbackStarted = deferred<void>();
    let poolClosed = false;
    let boundWorker: KnowledgeConflictRuntime["interactionWorker"] | undefined;
    let inFlightCallback: Promise<unknown> | undefined;
    const interactionWorker: KnowledgeConflictRuntime["interactionWorker"] = {
      async processInteraction() {
        callbackStarted.resolve();
        await callbackRelease.promise;
        if (poolClosed) throw new Error("conflict pool closed before callback drain");
        return { status: "applied", code: "conflict_dismissed" };
      },
    };
    const knowledgeCardRuntime = fakeKnowledgeCardRuntime({
      bindKnowledgeConflictInteractionWorker: vi.fn((worker) => { boundWorker = worker; }),
      close: vi.fn(async () => {
        await inFlightCallback;
      }),
    });
    const knowledgeConflictRuntime = fakeKnowledgeConflictRuntime({
      interactionWorker,
      close: vi.fn(async () => { poolClosed = true; }),
    });
    const app = await buildApp({
      createKnowledgeConflictRuntime: () => knowledgeConflictRuntime,
      createAnswerDraftRuntime: () => undefined,
      createReindexWorkerRuntime: () => undefined,
      createMemoryExtractionRuntime: () => undefined,
      createKnowledgeDraftRuntime: () => undefined,
      createKnowledgeCardRuntime: () => knowledgeCardRuntime,
      createActionApprovalRuntime: () => fakeActionApprovalRuntime(),
      createActionReviewRuntime: () => undefined,
      createProactiveSignalPlannerRuntime: () => undefined,
      createProactiveSignalDeliveryRuntime: () => undefined,
      createEventWorkerRuntime: () => undefined,
      createDocumentSyncRuntime: () => undefined,
    });
    await app.ready();
    if (boundWorker === undefined) throw new Error("conflict callback worker was not bound");
    inFlightCallback = boundWorker.processInteraction({} as never);
    await callbackStarted.promise;

    const closing = app.close();
    await vi.waitFor(() => expect(knowledgeCardRuntime.close).toHaveBeenCalledOnce());
    const conflictClosedBeforeDrain = poolClosed;
    callbackRelease.resolve();

    await expect(closing).resolves.toBeUndefined();
    expect(conflictClosedBeforeDrain).toBe(false);
    await expect(inFlightCallback).resolves.toMatchObject({
      status: "applied",
      code: "conflict_dismissed",
    });
    expect(knowledgeConflictRuntime.close).toHaveBeenCalledOnce();
    expect(knowledgeCardRuntime.close).toHaveBeenCalledOnce();
  });

  it("explicitly disables standalone conflict answers when the composed runtime is off", async () => {
    const createAnswerDraftRuntime = vi.fn(() => undefined);
    const app = await buildApp({
      createKnowledgeConflictRuntime: () => undefined,
      createAnswerDraftRuntime,
      createReindexWorkerRuntime: () => undefined,
      createMemoryExtractionRuntime: () => undefined,
      createKnowledgeDraftRuntime: () => undefined,
      createKnowledgeCardRuntime: () => undefined,
      createActionApprovalRuntime: () => undefined,
      createActionReviewRuntime: () => undefined,
      createProactiveSignalPlannerRuntime: () => undefined,
      createProactiveSignalDeliveryRuntime: () => undefined,
      createEventWorkerRuntime: () => undefined,
      createDocumentSyncRuntime: () => undefined,
    });

    expect(createAnswerDraftRuntime).toHaveBeenCalledWith(expect.objectContaining({
      knowledgeConflictAnswerProvider: null,
    }));
    await app.close();
  });

  it("surfaces rejected knowledge-conflict startup through app readiness and server startup", async () => {
    const startupError = new Error("knowledge conflict startup failed");
    const runtime = fakeKnowledgeConflictRuntime({
      start: vi.fn(async () => { throw startupError; }),
      close: vi.fn(async () => undefined),
    });
    const runtimeDependencies = {
      createKnowledgeConflictRuntime: () => runtime,
      createAnswerDraftRuntime: () => undefined,
      createReindexWorkerRuntime: () => undefined,
      createMemoryExtractionRuntime: () => undefined,
      createKnowledgeDraftRuntime: () => undefined,
      createKnowledgeCardRuntime: () => fakeKnowledgeCardRuntime(),
      createActionApprovalRuntime: () => fakeActionApprovalRuntime(),
      createActionReviewRuntime: () => undefined,
      createProactiveSignalPlannerRuntime: () => undefined,
      createProactiveSignalDeliveryRuntime: () => undefined,
      createEventWorkerRuntime: () => undefined,
      createDocumentSyncRuntime: () => undefined,
    } satisfies BuildAppDependencies;
    const app = await buildApp(runtimeDependencies);
    await expect(app.ready()).rejects.toBe(startupError);
    await app.close();

    const serverRuntime = fakeKnowledgeConflictRuntime({
      start: vi.fn(async () => { throw startupError; }),
      close: vi.fn(async () => undefined),
    });
    const runtimeControlRuntime = fakeRuntimeControlRuntime();
    await expect(startServer({
      createRuntimeControlRuntime: async () => runtimeControlRuntime,
      appDependencies: {
        ...runtimeDependencies,
        createKnowledgeConflictRuntime: () => serverRuntime,
      },
    })).rejects.toBe(startupError);
    expect(serverRuntime.close).toHaveBeenCalledOnce();
    expect(runtimeControlRuntime.close).toHaveBeenCalledOnce();
  });

  it("degrades consolidated status without leaking a conflict count failure", async () => {
    const runtime = fakeKnowledgeConflictRuntime({
      getStatus: vi.fn(async () => { throw new Error("candidate-id raw database detail"); }),
    });
    const app = await buildApp({
      createKnowledgeConflictRuntime: () => runtime,
      createAnswerDraftRuntime: () => undefined,
      createReindexWorkerRuntime: () => undefined,
      createMemoryExtractionRuntime: () => undefined,
      createKnowledgeDraftRuntime: () => undefined,
      createKnowledgeCardRuntime: () => fakeKnowledgeCardRuntime(),
      createActionApprovalRuntime: () => fakeActionApprovalRuntime(),
      createActionReviewRuntime: () => undefined,
      createProactiveSignalPlannerRuntime: () => undefined,
      createProactiveSignalDeliveryRuntime: () => undefined,
      createEventWorkerRuntime: () => undefined,
      createDocumentSyncRuntime: () => undefined,
    });
    await app.ready();

    const response = await app.inject({ method: "GET", url: "/internal/status" });
    expect(response.json().components.knowledgeConflicts).toEqual({
      status: "degraded",
      ok: false,
      enabled: true,
      running: false,
      degradedReason: "knowledge_conflict_status_unavailable",
    });
    expect(response.body).not.toContain("candidate-id");
    expect(response.body).not.toContain("raw database detail");
    await app.close();
  });

  it.each([
    "migration0046Applied",
    "migration0047Applied",
    "migration0048Applied",
  ] as const)("degrades consolidated status when %s is missing", async (migrationField) => {
    const runtime = fakeKnowledgeConflictRuntime();
    const healthyStatus = await runtime.getStatus();
    runtime.getStatus = vi.fn(async () => ({
      ...healthyStatus,
      [migrationField]: false,
    }));
    const app = await buildApp({
      createKnowledgeConflictRuntime: () => runtime,
      createAnswerDraftRuntime: () => undefined,
      createReindexWorkerRuntime: () => undefined,
      createMemoryExtractionRuntime: () => undefined,
      createKnowledgeDraftRuntime: () => undefined,
      createKnowledgeCardRuntime: () => fakeKnowledgeCardRuntime(),
      createActionApprovalRuntime: () => fakeActionApprovalRuntime(),
      createActionReviewRuntime: () => undefined,
      createProactiveSignalPlannerRuntime: () => undefined,
      createProactiveSignalDeliveryRuntime: () => undefined,
      createEventWorkerRuntime: () => undefined,
      createDocumentSyncRuntime: () => undefined,
    });
    await app.ready();

    const response = await app.inject({ method: "GET", url: "/internal/status" });
    expect(response.json().components.knowledgeConflicts).toMatchObject({
      status: "degraded",
      ok: false,
      enabled: true,
      degradedReason: "knowledge_conflict_runtime_degraded",
      [migrationField]: false,
    });
    await app.close();
  });

  it("awaits extraction cleanup when event runtime composition fails", async () => {
    const compositionError = new Error("event composition failed");
    const order: string[] = [];
    const extractionRuntime = fakeMemoryExtractionRuntime({
      start: vi.fn(() => order.push("start-extraction")),
      close: vi.fn(async () => {
        order.push("close-extraction");
      }),
    });
    const runtimeControlRuntime = fakeRuntimeControlRuntime({
      onClose: () => order.push("close-runtime-control"),
    });

    await expect(
      startServer({
        createRuntimeControlRuntime: async () => runtimeControlRuntime,
        appDependencies: {
          createAnswerDraftRuntime: () => undefined,
          createReindexWorkerRuntime: () => undefined,
          createMemoryExtractionRuntime: () => extractionRuntime,
          createEventWorkerRuntime: () => {
            throw compositionError;
          },
          createDocumentSyncRuntime: () => undefined,
        },
      }),
    ).rejects.toBe(compositionError);

    expect(order).toEqual([
      "start-extraction",
      "close-extraction",
      "close-runtime-control",
    ]);
    expect(extractionRuntime.close).toHaveBeenCalledOnce();
    expect(runtimeControlRuntime.close).toHaveBeenCalledOnce();
  });

  it("closes extraction after event runtime when the listener cannot bind", async () => {
    const occupied = await occupyLoopbackPort();
    occupiedServer = occupied.server;
    process.env.PORT = String(occupied.port);
    const closeOrder: string[] = [];
    const extractionRuntime = fakeMemoryExtractionRuntime({
      close: vi.fn(async () => {
        closeOrder.push("extraction");
      }),
    });
    const eventWorkerRuntime = fakeEventWorkerRuntime({
      close: vi.fn(async () => {
        closeOrder.push("event");
      }),
    });
    const runtimeControlRuntime = fakeRuntimeControlRuntime({
      onClose: () => closeOrder.push("runtime-control"),
    });

    await expect(
      startServer({
        createRuntimeControlRuntime: async () => runtimeControlRuntime,
        appDependencies: {
          createAnswerDraftRuntime: () => undefined,
          createReindexWorkerRuntime: () => undefined,
          createMemoryExtractionRuntime: () => extractionRuntime,
          createEventWorkerRuntime: () => eventWorkerRuntime,
          createDocumentSyncRuntime: () => undefined,
        },
      }),
    ).rejects.toMatchObject({ code: "EADDRINUSE" });

    expect(closeOrder).toEqual(["event", "extraction", "runtime-control"]);
    expect(extractionRuntime.close).toHaveBeenCalledOnce();
  });

  it("always injects the factory's matching runtime-control pair", async () => {
    const reservation = await occupyLoopbackPort();
    const port = reservation.port;
    await closeServer(reservation.server);
    process.env.PORT = String(port);
    const runtimeControlRuntime = fakeRuntimeControlRuntime();
    const expectedController = runtimeControlRuntime.runtimeControl.controller;
    const productionGetStatus = vi.spyOn(
      runtimeControlRuntime.runtimeControl.service,
      "getStatus",
    );
    const bypassRuntime = fakeRuntimeControlRuntime();
    const bypassGetStatus = vi.spyOn(bypassRuntime.runtimeControl.service, "getStatus");
    const bypassClose = vi.fn(async () => undefined);
    const createEventWorkerRuntime = vi.fn(() => undefined);

    const app = await startServer({
      createRuntimeControlRuntime: async () => runtimeControlRuntime,
      appDependencies: {
        createAnswerDraftRuntime: () => undefined,
        createEventWorkerRuntime,
        createDocumentSyncRuntime: () => undefined,
        createReindexWorkerRuntime: () => undefined,
        runtimeController: bypassRuntime.runtimeControl.controller,
        runtimeControl: bypassRuntime.runtimeControl,
        closeRuntimeControl: bypassClose,
      } as BuildAppDependencies,
    });

    try {
      expect(createEventWorkerRuntime).toHaveBeenCalledWith({
        runtimeController: expectedController,
      });
      const status = await app.inject({ method: "GET", url: "/internal/status" });
      expect(status.statusCode).toBe(200);
      expect(productionGetStatus).toHaveBeenCalledOnce();
      expect(bypassGetStatus).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }

    expect(runtimeControlRuntime.close).toHaveBeenCalledOnce();
    expect(bypassClose).not.toHaveBeenCalled();
  });

  it("closes runtime-control once when buildApp throws", async () => {
    const buildError = new Error("answer runtime composition failed");
    const runtimeCleanupError = new Error("runtime-control cleanup failed");
    const runtimeControlRuntime = fakeRuntimeControlRuntime({
      closeError: runtimeCleanupError,
    });
    const createEventWorkerRuntime = vi.fn(() => undefined);

    let startupError: unknown;
    try {
      await startServer({
        createRuntimeControlRuntime: async () => runtimeControlRuntime,
        appDependencies: {
          createAnswerDraftRuntime: () => {
            throw buildError;
          },
          createEventWorkerRuntime,
          createDocumentSyncRuntime: () => undefined,
          createReindexWorkerRuntime: () => undefined,
        },
      });
    } catch (error) {
      startupError = error;
    }

    expect(startupError).toBeInstanceOf(AggregateError);
    expect((startupError as AggregateError).errors).toEqual([
      buildError,
      runtimeCleanupError,
    ]);
    expect(createEventWorkerRuntime).not.toHaveBeenCalled();
    expect(runtimeControlRuntime.close).toHaveBeenCalledOnce();
  });

  it("awaits worker cleanup before runtime-control close when late composition fails", async () => {
    const occupied = await occupyLoopbackPort();
    occupiedServer = occupied.server;
    process.env.PORT = String(occupied.port);
    const closeOrder: string[] = [];
    const buildError = new Error("late app composition failed");
    const eventCloseError = new Error("event runtime cleanup failed");
    const reindexCloseError = new Error("reindex runtime cleanup failed");
    const fastifyCloseError = new Error("Fastify cleanup failed");
    const runtimeCloseError = new Error("runtime-control cleanup failed");
    let signalEventCloseStarted!: () => void;
    const eventCloseStarted = new Promise<void>((resolve) => {
      signalEventCloseStarted = resolve;
    });
    let rejectEventClose!: () => void;
    const eventWorkerRuntime = fakeEventWorkerRuntime({
      close: vi.fn(() => {
        closeOrder.push("event");
        signalEventCloseStarted();
        return new Promise<void>((_resolve, reject) => {
          rejectEventClose = () => reject(eventCloseError);
        });
      }),
    });
    const reindexWorkerRuntime = fakeReindexWorkerRuntime({
      close: vi.fn(async () => {
        closeOrder.push("reindex");
        throw reindexCloseError;
      }),
    });
    const answerDraftRuntime = {
      answerDraftOrchestrator: {
        generateDraft: vi.fn(async () => ({
          answerText: "Runtime draft",
          promptContext: "",
          allowedFragments: [],
          deniedDocumentIds: [],
          retrievedFragmentCount: 0,
          usedGroupMemories: [],
        })),
      },
      answerSourcePermissionVerifier: { verify: vi.fn(async () => []) },
      close: vi.fn(async () => {
        closeOrder.push("answer");
      }),
    };
    const runtimeControlRuntime = fakeRuntimeControlRuntime({
      closeError: runtimeCloseError,
      onClose: () => closeOrder.push("runtime-control"),
    });

    const startupOutcome = startServer({
      createRuntimeControlRuntime: async () => runtimeControlRuntime,
      appDependencies: {
        createAnswerDraftRuntime: () => answerDraftRuntime,
        createReindexWorkerRuntime: () => reindexWorkerRuntime,
        createEventWorkerRuntime: () => eventWorkerRuntime,
        createDocumentSyncRuntime: () => undefined,
        onBeforeRuntimeCloseOwnership: (app: FastifyInstance) => {
          app.addHook("onClose", async () => {
            closeOrder.push("fastify");
            throw fastifyCloseError;
          });
          throw buildError;
        },
      },
    }).then(
      () => ({ error: undefined as unknown }),
      (error: unknown) => ({ error }),
    );

    await eventCloseStarted;
    const runtimeCloseCountBeforeWorkerCleanup = vi.mocked(
      runtimeControlRuntime.close,
    ).mock.calls.length;
    rejectEventClose();
    const { error: startupError } = await startupOutcome;

    expect(runtimeCloseCountBeforeWorkerCleanup).toBe(0);
    expect(closeOrder).toEqual([
      "event",
      "reindex",
      "answer",
      "fastify",
      "runtime-control",
    ]);
    expect(startupError).toBeInstanceOf(AggregateError);
    expect((startupError as AggregateError).errors).toEqual([
      buildError,
      eventCloseError,
      reindexCloseError,
      fastifyCloseError,
      runtimeCloseError,
    ]);
    expect(reindexWorkerRuntime.start).toHaveBeenCalledOnce();
    expect(eventWorkerRuntime.start).toHaveBeenCalledOnce();
    expect(eventWorkerRuntime.close).toHaveBeenCalledOnce();
    expect(reindexWorkerRuntime.close).toHaveBeenCalledOnce();
    expect(answerDraftRuntime.close).toHaveBeenCalledOnce();
    expect(runtimeControlRuntime.close).toHaveBeenCalledOnce();
  });

  it("closes composed runtime resources when the listener cannot bind", async () => {
    const occupied = await occupyLoopbackPort();
    occupiedServer = occupied.server;
    process.env.PORT = String(occupied.port);
    const eventWorkerRuntime = fakeEventWorkerRuntime();
    const runtimeControlRuntime = fakeRuntimeControlRuntime();

    await expect(
      startServer({
        createRuntimeControlRuntime: async () => runtimeControlRuntime,
        appDependencies: {
          createAnswerDraftRuntime: () => undefined,
          createEventWorkerRuntime: () => eventWorkerRuntime,
          createDocumentSyncRuntime: () => undefined,
          createReindexWorkerRuntime: () => undefined,
        },
      }),
    ).rejects.toMatchObject({ code: "EADDRINUSE" });

    expect(eventWorkerRuntime.start).toHaveBeenCalledOnce();
    expect(eventWorkerRuntime.close).toHaveBeenCalledOnce();
    expect(runtimeControlRuntime.close).toHaveBeenCalledOnce();
  });

  it("preserves every listener cleanup failure in flat causal order", async () => {
    const occupied = await occupyLoopbackPort();
    occupiedServer = occupied.server;
    process.env.PORT = String(occupied.port);
    const eventCleanupError = new Error("event runtime cleanup failed");
    const runtimeCleanupError = new Error("runtime-control cleanup failed");
    const closeOrder: string[] = [];
    const eventWorkerRuntime = fakeEventWorkerRuntime({
      close: vi.fn(async () => {
        closeOrder.push("event");
        throw eventCleanupError;
      }),
    });
    const runtimeControlRuntime = fakeRuntimeControlRuntime({
      closeError: runtimeCleanupError,
      onClose: () => closeOrder.push("runtime-control"),
    });

    let startupError: unknown;
    try {
      await startServer({
        createRuntimeControlRuntime: async () => runtimeControlRuntime,
        appDependencies: {
          createAnswerDraftRuntime: () => undefined,
          createEventWorkerRuntime: () => eventWorkerRuntime,
          createDocumentSyncRuntime: () => undefined,
          createReindexWorkerRuntime: () => undefined,
        },
      });
    } catch (error) {
      startupError = error;
    }

    expect(startupError).toBeInstanceOf(AggregateError);
    const errors = (startupError as AggregateError).errors;
    expect(errors).toHaveLength(3);
    expect(errors[0]).toMatchObject({ code: "EADDRINUSE" });
    expect(errors[1]).toBe(eventCleanupError);
    expect(errors[2]).toBe(runtimeCleanupError);
    expect(closeOrder).toEqual(["event", "runtime-control"]);
    expect(eventWorkerRuntime.close).toHaveBeenCalledOnce();
    expect(runtimeControlRuntime.close).toHaveBeenCalledOnce();
  });
});

async function occupyLoopbackPort(): Promise<{ server: Server; port: number }> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    await closeServer(server);
    throw new Error("occupied test server did not expose a TCP port");
  }

  return { server, port: address.port };
}

async function closeServer(server: Server | undefined): Promise<void> {
  if (server === undefined || !server.listening) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    });
  });
}

function fakeEventWorkerRuntime(
  overrides: Partial<EventWorkerRuntime> = {},
): EventWorkerRuntime {
  return {
    deadLetters: {
      list: vi.fn(async () => []),
      replay: vi.fn(async () => "not_found" as const),
      delete: vi.fn(async () => "not_found" as const),
      replayBatch: vi.fn(async () => ({
        replayedCount: 0,
        notFoundIds: [],
        unsupportedLegacyIds: [],
      })),
    },
    getStatus: vi.fn(async () => ({
      enabled: true as const,
      running: true,
      intervalMs: 100,
      batchLimit: 10,
      mentionRepliesEnabled: false,
      pendingEventCount: 0,
      deadLetterEventCount: 0,
      answerReplyUnresolvedCount: 0,
      answerReplyPendingSafeNoticeCount: 0,
      answerReplyReconciliationRequiredCount: 0,
    })),
    start: vi.fn(),
    close: vi.fn(async () => undefined),
    ...overrides,
  };
}

function fakeReindexWorkerRuntime(
  overrides: Partial<ReindexWorkerRuntime> = {},
): ReindexWorkerRuntime {
  return {
    activeEmbeddingProfileId: "openai-compatible:text-embedding-small:1536",
    planner: {
      planDocumentProfileReindex: vi.fn(async () => ({
        enqueuedCount: 0,
        skippedCount: 0,
      })),
    },
    deadLetters: {
      list: vi.fn(async () => []),
      replay: vi.fn(async () => "not_found" as const),
      delete: vi.fn(async () => "not_found" as const),
      replayBatch: vi.fn(async () => ({
        replayedCount: 0,
        notFoundIds: [],
        unsupportedLegacyIds: [],
      })),
    },
    getStatus: vi.fn(async () => ({
      enabled: true as const,
      running: true,
      activeEmbeddingProfileId: "openai-compatible:text-embedding-small:1536",
      intervalMs: 100,
      batchLimit: 10,
      pendingJobCount: 0,
      deadLetterJobCount: 0,
    })),
    start: vi.fn(),
    close: vi.fn(async () => undefined),
    ...overrides,
  };
}

function fakeMemoryExtractionRuntime(
  overrides: Partial<MemoryExtractionRuntime> = {},
): MemoryExtractionRuntime {
  return {
    planner: { registerMessage: vi.fn(async () => undefined) },
    deadLetters: {
      list: vi.fn(async () => []),
      replay: vi.fn(async () => "not_found" as const),
      delete: vi.fn(async () => "not_found" as const),
      replayBatch: vi.fn(async () => ({
        replayedCount: 0,
        notFoundIds: [],
        unsupportedLegacyIds: [],
      })),
    },
    getStatus: vi.fn(async () => ({
      enabled: true as const,
      running: true,
      workerHealthy: true,
      intervalMs: 1000,
      batchLimit: 20,
      minConfidence: 0.85,
      pendingJobCount: 0,
      processingJobCount: 0,
      delayedJobCount: 0,
      deadLetterJobCount: 0,
      acceptedCandidateCount: 0,
      rejectedCandidateCount: 0,
      duplicateCandidateCount: 0,
      conflictCandidateCount: 0,
      acceptedThreadOperationCount: 0,
      rejectedThreadOperationCount: 0,
      acceptedActionOperationCount: 0,
      rejectedActionOperationCount: 0,
      skippedRequestCount: 0,
      failedRunCount: 0,
    })),
    start: vi.fn(),
    close: vi.fn(async () => undefined),
    ...overrides,
  };
}

function fakeKnowledgeCardRuntime(
  overrides: Partial<KnowledgeCardRuntime> = {},
): KnowledgeCardRuntime {
  return {
    gateway: { handleCallback: vi.fn() },
    repository: {} as KnowledgeCardRuntime["repository"],
    deadLetters: {
      list: vi.fn(async () => []),
      replay: vi.fn(async () => "not_found" as const),
      delete: vi.fn(async () => "not_found" as const),
    },
    canUseKnowledgeCards: vi.fn(() => true),
    approvalInteractions: {} as KnowledgeCardRuntime["approvalInteractions"],
    bindActionApprovalWorker: vi.fn(),
    start: vi.fn(),
    getStatus: vi.fn(),
    close: vi.fn(async () => undefined),
    ...overrides,
    bindKnowledgeConflictInteractionWorker:
      overrides.bindKnowledgeConflictInteractionWorker ?? vi.fn(),
  };
}

function fakeKnowledgeConflictRuntime(
  overrides: Partial<KnowledgeConflictRuntime> = {},
): KnowledgeConflictRuntime {
  return {
    repository: {} as KnowledgeConflictRuntime["repository"],
    currentValidator: {} as KnowledgeConflictRuntime["currentValidator"],
    answerProvider: { findConflictPlan: vi.fn(async () => undefined) },
    interactionWorker: { processInteraction: vi.fn() } as never,
    canUseKnowledgeConflict: vi.fn(() => true),
    start: vi.fn(async () => undefined),
    getStatus: vi.fn(async () => ({
      enabled: true as const,
      running: true,
      migration0046Applied: true,
      migration0047Applied: true,
      migration0048Applied: true,
      enabledGroupCount: 1,
      scanner: { running: true, intervalMs: 60_000, batchLimit: 10 },
      dispatcher: { running: true, intervalMs: 1_000, batchLimit: 10 },
      scans: { pending: 0, processing: 0, retry: 0, completed: 0, deadLettered: 0 },
      candidates: {
        pending_review: 0,
        dismissed: 0,
        approved_for_delivery: 0,
        delivered: 0,
        draft_created: 0,
        superseded: 0,
      },
      deliveries: {
        pending: 0,
        processing: 0,
        externalAttempting: 0,
        sent: 0,
        failed: 0,
        terminalFailed: 0,
        outcomeUnknown: 0,
        cancelled: 0,
      },
      interactions: { applied: 0, alreadyApplied: 0, rejected: 0 },
      reconciliation: { terminalFailed: 0, outcomeUnknown: 0 },
    })),
    close: vi.fn(async () => undefined),
    ...overrides,
  };
}

function fakeActionApprovalRuntime(
  overrides: Partial<ActionApprovalRuntime> = {},
): ActionApprovalRuntime {
  return {
    repository: {} as ActionApprovalRuntime["repository"],
    canUseActionApprovalsForSourceGroup: vi.fn(() => true),
    start: vi.fn(),
    getStatus: vi.fn(),
    close: vi.fn(async () => undefined),
    ...overrides,
  };
}

function fakeActionReviewRuntime(
  overrides: Partial<ActionReviewRuntime> = {},
): ActionReviewRuntime {
  return {
    repository: {} as ActionReviewRuntime["repository"],
    codec: {} as ActionReviewRuntime["codec"],
    oauthClient: {} as ActionReviewRuntime["oauthClient"],
    getStatus: vi.fn(async () => ({
      configured: true as const,
      running: true,
      migration0053Applied: true,
    })),
    close: vi.fn(async () => undefined),
    ...overrides,
  };
}

function fakeProactiveSignalDeliveryRuntime(
  overrides: Partial<ProactiveSignalDeliveryRuntime> = {},
): ProactiveSignalDeliveryRuntime {
  return {
    repository: {} as ProactiveSignalDeliveryRuntime["repository"],
    canUseProactiveSignalDelivery: vi.fn(() => true),
    start: vi.fn(),
    getStatus: vi.fn(async () => ({
      enabled: true as const,
      running: true,
      enabledGroupCount: 1,
      dispatcher: { running: true, intervalMs: 1000, batchLimit: 10 },
    })),
    close: vi.fn(async () => undefined),
    ...overrides,
  };
}

function fakeProactiveSignalPlannerRuntime(
  overrides: Partial<ProactiveSignalPlannerRuntime> = {},
): ProactiveSignalPlannerRuntime {
  return {
    repository: {} as ProactiveSignalPlannerRuntime["repository"],
    canUseProactiveSignalPlanning: vi.fn(() => true),
    start: vi.fn(),
    getStatus: vi.fn(async () => ({
      enabled: true as const,
      running: true,
      enabledGroupCount: 1,
      scanner: { running: true, intervalMs: 60000, batchLimit: 10 },
    })),
    close: vi.fn(async () => undefined),
    ...overrides,
  };
}

function fakeConversationStateInspectionStore() {
  return {
    getStatus: vi.fn(),
    listThreads: vi.fn(),
    listActions: vi.fn(),
    listThreadEvents: vi.fn(),
    listActionEvents: vi.fn(),
    deleteMessageEvidence: vi.fn(),
  };
}

function fakeRuntimeControlRuntime({
  closeError,
  onClose,
}: {
  closeError?: Error;
  onClose?: () => void;
} = {}): RuntimeControlRuntime & { close: ReturnType<typeof vi.fn> } {
  const controller = new RuntimeController(
    createDefaultRuntimeConfig({ IRIS_RUNTIME_GLOBAL_ENABLED: "false" }),
  );
  const service = createInMemoryRuntimeControlService(controller, () => new Date());

  return {
    runtimeControl: { controller, service },
    close: vi.fn(async () => {
      onClose?.();
      if (closeError !== undefined) {
        throw closeError;
      }
    }),
  };
}

function deferred<T>() {
  let resolve!: (value?: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise as typeof resolve;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
