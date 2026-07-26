import { describe, expect, it, vi } from "vitest";

import type { AgentExecutionLedgerRepository } from "../src/agent-runtime/agent-execution-ledger-repository.js";
import {
  createAgentExecutionLedgerRuntime,
  type AgentExecutionLedgerRuntimeDependencies,
} from "../src/runtime/agent-execution-ledger-runtime.js";

const now = new Date("2026-07-27T12:00:00.000Z");

describe("AgentExecutionLedgerRuntime", () => {
  it("allocates no resources while disabled", () => {
    const dependencies = runtimeDependencies();

    expect(createAgentExecutionLedgerRuntime({ env: {}, dependencies })).toBeUndefined();
    expect(dependencies.createPostgresPool).not.toHaveBeenCalled();
    expect(dependencies.createRepository).not.toHaveBeenCalled();
  });

  it("owns one repository and closes its pool idempotently", async () => {
    const dependencies = runtimeDependencies();
    const runtime = createAgentExecutionLedgerRuntime({
      env: enabledEnv(),
      dependencies,
      now: () => now,
      createId: () => "ledger-event-1",
    })!;

    expect(dependencies.createPostgresPool).toHaveBeenCalledWith({
      databaseUrl: "postgres://iris:secret@postgres:5432/iris",
    });
    expect(dependencies.createRepository).toHaveBeenCalledWith({
      dataSource: dependencies.pool,
    });
    expect(runtime.repository).toBe(dependencies.repository);
    expect(runtime.getStatus()).toEqual({
      enabled: true,
      writeFailureCount: 0,
    });

    await runtime.close();
    await runtime.close();

    expect(dependencies.pool.end).toHaveBeenCalledTimes(1);
  });

  it("reports observer storage degradation without rejecting business work", async () => {
    const storageError = new Error("database unavailable");
    const dependencies = runtimeDependencies({
      recordEvent: vi.fn(async () => {
        throw storageError;
      }),
    });
    const runtime = createAgentExecutionLedgerRuntime({
      env: enabledEnv(),
      dependencies,
      now: () => now,
      createId: () => "ledger-event-2",
    })!;

    await expect(runtime.observer.observe({
      subjectType: "turn",
      subjectId: "om_123",
      eventType: "turn_failed",
      outcome: "error",
      operationKey: "turn:om_123:failed",
      metadata: { reason: "provider_unavailable" },
    })).resolves.toBeUndefined();
    expect(runtime.getStatus()).toEqual({
      enabled: true,
      writeFailureCount: 1,
      lastWriteFailureAt: now,
    });

    await runtime.close();
  });
});

function enabledEnv() {
  return {
    IRIS_AGENT_EXECUTION_LEDGER_ENABLED: "true",
    DATABASE_URL: "postgres://iris:secret@postgres:5432/iris",
  };
}

function runtimeDependencies({
  recordEvent = vi.fn<AgentExecutionLedgerRepository["recordEvent"]>(),
}: {
  recordEvent?: ReturnType<typeof vi.fn<AgentExecutionLedgerRepository["recordEvent"]>>;
} = {}) {
  const pool = {
    query: vi.fn(),
    connect: vi.fn(),
    end: vi.fn(async () => undefined),
  };
  const repository = {
    recordEvent,
    listEvents: vi.fn<AgentExecutionLedgerRepository["listEvents"]>().mockResolvedValue([]),
  } as AgentExecutionLedgerRepository;
  const dependencies = {
    createPostgresPool: vi.fn(() => pool),
    createRepository: vi.fn(() => repository),
  } satisfies AgentExecutionLedgerRuntimeDependencies;
  return Object.assign(dependencies, { pool, repository });
}
