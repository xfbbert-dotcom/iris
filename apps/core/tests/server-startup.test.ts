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
import type { ProactiveSignalDeliveryRuntime } from "../src/runtime/proactive-signal-delivery-runtime.js";
import type { ReindexWorkerRuntime } from "../src/runtime/reindex-worker-runtime.js";
import type { RuntimeControlRuntime } from "../src/runtime/runtime-control-runtime.js";
import type { KnowledgeCardRuntime } from "../src/runtime/knowledge-card-runtime.js";
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
      expect(input).toEqual({ runtimeController: runtimeControlRuntime.runtimeControl.controller });
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
      "close-action-approvals",
      "close-knowledge-cards",
      "close-runtime-control",
    ]);
    expect(createKnowledgeCardRuntime).toHaveBeenCalledOnce();
    expect(createActionApprovalRuntime).toHaveBeenCalledOnce();
    expect(createActionReviewRuntime).toHaveBeenCalledOnce();
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
        createKnowledgeCardRuntime: () => undefined,
        createActionApprovalRuntime: () => actionApprovalRuntime,
        createActionReviewRuntime: () => undefined,
        createProactiveSignalDeliveryRuntime,
        createEventWorkerRuntime: () => eventWorkerRuntime,
        createDocumentSyncRuntime: () => undefined,
      },
    });

    expect(order).toEqual(["start-action-approvals", "start-proactive-signals", "start-event"]);
    await app.close();
    expect(order).toEqual([
      "start-action-approvals",
      "start-proactive-signals",
      "start-event",
      "close-event",
      "close-proactive-signals",
      "close-action-approvals",
      "close-runtime-control",
    ]);
    expect(createProactiveSignalDeliveryRuntime).toHaveBeenCalledOnce();
  });

  it("surfaces a rejected knowledge-card startup through buildApp readiness and closes once", async () => {
    const startError = new Error("knowledge-card startup failed");
    const startup = Promise.reject(startError);
    void startup.catch(() => undefined);
    const knowledgeCardRuntime = fakeKnowledgeCardRuntime({
      start: vi.fn(() => startup),
      close: vi.fn(async () => undefined),
    });
    const app = buildApp({
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
      migration0034Applied: true,
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
