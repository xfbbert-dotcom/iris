import type pg from "pg";

import { describe, expect, it, vi } from "vitest";

import {
  createRuntimeControlRuntime,
  type RuntimeControlRuntime,
} from "../src/runtime/runtime-control-runtime.js";
import type { IrisCapability } from "../src/config/runtime-config.js";
import type { DatabaseConfig } from "../src/database/database-config.js";

describe("createRuntimeControlRuntime", () => {
  it("restores durable policy and metadata while forcing live global disabled", async () => {
    const snapshot = snapshotRow({
      revision: "7",
      desired_global_enabled: true,
      disabled_group_ids: ["chat-b", "chat-a"],
      capabilities: {
        ...defaultCapabilities(),
        proactiveSpeech: false,
      },
      updated_at: new Date("2026-07-13T01:02:03.000Z"),
      updated_by: "operator@example.com",
    });
    const fixture = runtimeFixture({ rows: [snapshot] });

    const runtime = await createRuntimeControlRuntime({
      env: {
        DATABASE_URL: "postgres://iris:secret@postgres:5432/iris",
        IRIS_RUNTIME_GLOBAL_ENABLED: "true",
      },
      createPool: fixture.createPool,
    });

    expect(fixture.createPool).toHaveBeenCalledOnce();
    expect(fixture.createPool).toHaveBeenCalledWith({
      databaseUrl: "postgres://iris:secret@postgres:5432/iris",
    });
    expect(fixture.query).toHaveBeenCalledOnce();
    expect(fixture.query.mock.calls[0]?.[0]).toContain("from runtime_control_state");
    expect(runtime.runtimeControl.controller.getSnapshot()).toEqual({
      globalEnabled: false,
      desiredGlobalEnabled: true,
      activationRequired: true,
      disabledGroupIds: ["chat-a", "chat-b"],
      capabilities: {
        ...defaultCapabilities(),
        proactiveSpeech: false,
      },
      revision: 7,
      updatedAt: new Date("2026-07-13T01:02:03.000Z"),
      updatedBy: "operator@example.com",
    });
    expect(runtime.runtimeControl.service.persistenceStorage).toBe("postgres");

    await runtime.close();
    expect(fixture.end).toHaveBeenCalledOnce();
  });

  it.each([
    [undefined, "DATABASE_URL is required"],
    ["not-a-url", "DATABASE_URL must be a postgres URL"],
  ])("rejects DATABASE_URL %s before creating a pool", async (databaseUrl, message) => {
    const createPool = vi.fn((_config: DatabaseConfig) => {
      throw new Error("pool must not be created");
    });

    await expect(
      createRuntimeControlRuntime({
        env: databaseUrl === undefined ? {} : { DATABASE_URL: databaseUrl },
        createPool,
      }),
    ).rejects.toThrow(message);

    expect(createPool).not.toHaveBeenCalled();
  });

  it.each([
    new Error("postgres unavailable"),
    new Error("invalid runtime control snapshot: row"),
  ])("fails closed and closes the pool when durable state cannot load", async (error) => {
    const fixture = runtimeFixture({ queryError: error });

    await expect(createRuntimeControlRuntime({
      env: { DATABASE_URL: "postgres://localhost/iris" },
      createPool: fixture.createPool,
    })).rejects.toBe(error);

    expect(fixture.end).toHaveBeenCalledOnce();
  });

  it("closes the pool when strict snapshot decoding fails", async () => {
    const fixture = runtimeFixture({
      rows: [snapshotRow({ capabilities: { ...defaultCapabilities(), extra: true } })],
    });

    await expect(createRuntimeControlRuntime({
      env: { DATABASE_URL: "postgres://localhost/iris" },
      createPool: fixture.createPool,
    })).rejects.toThrow("invalid runtime control snapshot: capabilities");

    expect(fixture.end).toHaveBeenCalledOnce();
  });

  it("preserves durable load and pool cleanup failures in causal order", async () => {
    const loadError = new Error("postgres unavailable");
    const cleanupError = new Error("pool close failed");
    const fixture = runtimeFixture({ queryError: loadError, closeError: cleanupError });

    let startupError: unknown;
    try {
      await createRuntimeControlRuntime({
        env: { DATABASE_URL: "postgres://localhost/iris" },
        createPool: fixture.createPool,
      });
    } catch (error) {
      startupError = error;
    }

    expect(startupError).toBeInstanceOf(AggregateError);
    expect((startupError as AggregateError).errors).toEqual([loadError, cleanupError]);
    expect(fixture.end).toHaveBeenCalledOnce();
  });

  it("closes the pool exactly once across concurrent and repeated cleanup", async () => {
    let releaseClose: (() => void) | undefined;
    const fixture = runtimeFixture({
      closeImplementation: () => new Promise<void>((resolve) => {
        releaseClose = resolve;
      }),
    });
    const runtime = await createFixtureRuntime(fixture);

    const firstClose = runtime.close();
    const secondClose = runtime.close();
    releaseClose?.();
    await Promise.all([firstClose, secondClose]);
    await runtime.close();

    expect(fixture.end).toHaveBeenCalledOnce();
  });
});

function runtimeFixture({
  rows = [snapshotRow()],
  queryError,
  closeError,
  closeImplementation,
}: {
  rows?: unknown[];
  queryError?: Error;
  closeError?: Error;
  closeImplementation?: () => Promise<void>;
} = {}) {
  const query = vi.fn(async (_sql: string) => {
    if (queryError !== undefined) {
      throw queryError;
    }
    return { rows };
  });
  const end = vi.fn(async () => {
    if (closeImplementation !== undefined) {
      return closeImplementation();
    }
    if (closeError !== undefined) {
      throw closeError;
    }
  });
  const pool = { query, end } as unknown as pg.Pool;
  const createPool = vi.fn((_config: DatabaseConfig) => pool);

  return { createPool, end, query };
}

async function createFixtureRuntime(
  fixture: ReturnType<typeof runtimeFixture>,
): Promise<RuntimeControlRuntime> {
  return createRuntimeControlRuntime({
    env: { DATABASE_URL: "postgres://localhost/iris" },
    createPool: fixture.createPool,
  });
}

function snapshotRow(overrides: Record<string, unknown> = {}) {
  return {
    revision: "0",
    desired_global_enabled: false,
    disabled_group_ids: [],
    capabilities: defaultCapabilities(),
    updated_at: new Date("2026-07-13T00:00:00.000Z"),
    updated_by: null,
    ...overrides,
  };
}

function defaultCapabilities(): IrisCapability {
  return {
    readGroupContext: true,
    replyWhenMentioned: true,
    readGroupDocuments: true,
    retrieveKnowledgeBase: true,
    proactiveSpeech: true,
    generateKnowledgeDrafts: true,
    writeKnowledgeBase: false,
    callExternalTools: false,
  };
}
