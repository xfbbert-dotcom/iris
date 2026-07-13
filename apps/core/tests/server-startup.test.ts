import { createServer, type Server } from "node:net";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  startServer,
  type BuildAppDependencies,
} from "../src/app.js";
import {
  createInMemoryRuntimeControlService,
} from "../src/admin/runtime-control-service.js";
import { RuntimeController } from "../src/admin/runtime-controller.js";
import { createDefaultRuntimeConfig } from "../src/config/runtime-config.js";
import type { EventWorkerRuntime } from "../src/runtime/event-worker-runtime.js";
import type { RuntimeControlRuntime } from "../src/runtime/runtime-control-runtime.js";
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

  it("preserves listener and runtime-control cleanup failures in causal order", async () => {
    const occupied = await occupyLoopbackPort();
    occupiedServer = occupied.server;
    process.env.PORT = String(occupied.port);
    const cleanupError = new Error("runtime-control cleanup failed");
    const eventWorkerRuntime = fakeEventWorkerRuntime();
    const runtimeControlRuntime = fakeRuntimeControlRuntime({
      closeError: cleanupError,
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
    expect(errors).toHaveLength(2);
    expect(errors[0]).toMatchObject({ code: "EADDRINUSE" });
    expect(errors[1]).toBe(cleanupError);
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

function fakeEventWorkerRuntime(): EventWorkerRuntime {
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
  };
}

function fakeRuntimeControlRuntime({
  closeError,
}: {
  closeError?: Error;
} = {}): RuntimeControlRuntime & { close: ReturnType<typeof vi.fn> } {
  const controller = new RuntimeController(
    createDefaultRuntimeConfig({ IRIS_RUNTIME_GLOBAL_ENABLED: "false" }),
  );
  const service = createInMemoryRuntimeControlService(controller, () => new Date());

  return {
    runtimeControl: { controller, service },
    close: vi.fn(async () => {
      if (closeError !== undefined) {
        throw closeError;
      }
    }),
  };
}
