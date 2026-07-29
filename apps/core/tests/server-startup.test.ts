import { createServer, type Server } from "node:net";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { startServer } from "../src/app.js";
import { RuntimeController } from "../src/admin/runtime-controller.js";
import { PostgresAuditLog } from "../src/audit/postgres-audit-log.js";
import { createDefaultRuntimeConfig } from "../src/config/runtime-config.js";
import type { EventWorkerRuntime } from "../src/runtime/event-worker-runtime.js";
import { isolateEnvVar } from "./test-env.js";

let restorePort: () => void = () => undefined;
let restoreInternalApiToken: () => void = () => undefined;
let restoreFeishuVerificationToken: () => void = () => undefined;
let occupiedServer: Server | undefined;

beforeEach(() => {
  restorePort = isolateEnvVar("PORT");
  restoreInternalApiToken = isolateEnvVar("IRIS_INTERNAL_API_TOKEN");
  restoreFeishuVerificationToken = isolateEnvVar("FEISHU_VERIFICATION_TOKEN");
});

afterEach(async () => {
  await closeServer(occupiedServer);
  occupiedServer = undefined;
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

    await expect(
      startServer({
        persistRuntimeControl: false,
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
  });

  it("returns a listening app that closes runtime resources normally", async () => {
    const reservation = await occupyLoopbackPort();
    const port = reservation.port;
    await closeServer(reservation.server);
    process.env.PORT = String(port);
    const eventWorkerRuntime = fakeEventWorkerRuntime();

    const app = await startServer({
      persistRuntimeControl: false,
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
  });

  it("serves restored runtime controls and closes their database resource", async () => {
    const reservation = await occupyLoopbackPort();
    const port = reservation.port;
    await closeServer(reservation.server);
    process.env.PORT = String(port);
    const controller = new RuntimeController(createDefaultRuntimeConfig());
    await controller.disableGlobal();
    const auditLog = await PostgresAuditLog.create({
      load: async () => ({ events: [], droppedEventCount: 0 }),
      record: async () => undefined,
    });
    const close = vi.fn(async () => undefined);

    const app = await startServer({
      createRuntimeControlRuntime: async () => ({
        controller,
        auditLog,
        close,
      }),
      appDependencies: {
        createAnswerDraftRuntime: () => undefined,
        createEventWorkerRuntime: () => undefined,
        createDocumentSyncRuntime: () => undefined,
        createReindexWorkerRuntime: () => undefined,
      },
    });

    const status = await app.inject({
      method: "GET",
      url: "/internal/runtime-control/status",
    });
    expect(status.json()).toMatchObject({
      ok: true,
      globalEnabled: false,
    });
    const auditStatus = await app.inject({
      method: "GET",
      url: "/internal/audit/status",
    });
    expect(auditStatus.json()).toMatchObject({
      ok: true,
      storage: "postgres",
    });

    await app.close();
    expect(close).toHaveBeenCalledOnce();
  });

  it("closes composed runtime resources when the listener cannot bind", async () => {
    const occupied = await occupyLoopbackPort();
    occupiedServer = occupied.server;
    process.env.PORT = String(occupied.port);
    const eventWorkerRuntime = fakeEventWorkerRuntime();

    await expect(
      startServer({
        persistRuntimeControl: false,
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
  });

  it("preserves both listener and cleanup failures", async () => {
    const occupied = await occupyLoopbackPort();
    occupiedServer = occupied.server;
    process.env.PORT = String(occupied.port);
    const cleanupError = new Error("event runtime cleanup failed");
    const eventWorkerRuntime = fakeEventWorkerRuntime();
    eventWorkerRuntime.close = vi.fn(async () => {
      throw cleanupError;
    });

    let startupError: unknown;
    try {
      await startServer({
        persistRuntimeControl: false,
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
