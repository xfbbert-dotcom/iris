import { describe, expect, it, vi } from "vitest";

import type {
  AgentExecutionLedgerRepository,
} from "../src/agent-runtime/agent-execution-ledger-repository.js";
import { buildApp } from "../src/app.js";
import type {
  AgentExecutionLedgerRuntime,
} from "../src/runtime/agent-execution-ledger-runtime.js";

const authorization = { authorization: "Bearer operator-secret" };

describe("agent execution ledger app composition", () => {
  it("creates one runtime, protects its API, exposes status, and closes it once", async () => {
    const runtime = fakeRuntime();
    const createAgentExecutionLedgerRuntime = vi.fn(() => runtime);
    const app = buildApp({
      internalApiToken: "operator-secret",
      now: () => new Date("2026-07-27T14:00:00.000Z"),
      createAgentExecutionLedgerRuntime,
      createAnswerDraftRuntime: () => undefined,
      createMemoryExtractionRuntime: () => undefined,
      createEventWorkerRuntime: () => undefined,
      createDocumentSyncRuntime: () => undefined,
      createReindexWorkerRuntime: () => undefined,
      createConversationStateInspectionRuntime: () => undefined,
      createProactiveSignalRuntime: () => undefined,
      createKnowledgeDraftRuntime: () => undefined,
      createKnowledgeCardRuntime: () => undefined,
      createActionApprovalRuntime: () => undefined,
      createActionReviewRuntime: () => undefined,
      createProactiveSignalPlannerRuntime: () => undefined,
      createProactiveSignalDeliveryRuntime: () => undefined,
    });

    const unauthorized = await app.inject({
      method: "GET",
      url: "/internal/agent-executions?limit=10",
    });
    const listed = await app.inject({
      method: "GET",
      url: "/internal/agent-executions?limit=10",
      headers: authorization,
    });
    const status = await app.inject({
      method: "GET",
      url: "/internal/status",
      headers: authorization,
    });

    expect(unauthorized.statusCode).toBe(401);
    expect(listed.statusCode).toBe(200);
    expect(runtime.repository.listEvents).toHaveBeenCalledWith({ limit: 10 });
    expect(status.statusCode).toBe(200);
    expect(status.json().components.agentExecutionLedger).toEqual({
      status: "healthy",
      ok: true,
      enabled: true,
      writeFailureCount: 0,
    });
    expect(createAgentExecutionLedgerRuntime).toHaveBeenCalledOnce();

    await app.close();
    await app.close();

    expect(runtime.close).toHaveBeenCalledOnce();
  });

  it("marks ledger write degradation without exposing the underlying error", async () => {
    const runtime = fakeRuntime({
      status: {
        enabled: true,
        writeFailureCount: 2,
        lastWriteFailureAt: new Date("2026-07-27T13:59:00.000Z"),
      },
    });
    const app = buildApp({
      internalApiToken: "operator-secret",
      createAgentExecutionLedgerRuntime: () => runtime,
      createAnswerDraftRuntime: () => undefined,
      createMemoryExtractionRuntime: () => undefined,
      createEventWorkerRuntime: () => undefined,
      createDocumentSyncRuntime: () => undefined,
      createReindexWorkerRuntime: () => undefined,
      createConversationStateInspectionRuntime: () => undefined,
      createProactiveSignalRuntime: () => undefined,
      createKnowledgeDraftRuntime: () => undefined,
      createKnowledgeCardRuntime: () => undefined,
      createActionApprovalRuntime: () => undefined,
      createActionReviewRuntime: () => undefined,
      createProactiveSignalPlannerRuntime: () => undefined,
      createProactiveSignalDeliveryRuntime: () => undefined,
    });

    const response = await app.inject({
      method: "GET",
      url: "/internal/status",
      headers: authorization,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().components.agentExecutionLedger).toEqual({
      status: "degraded",
      ok: false,
      enabled: true,
      writeFailureCount: 2,
      lastWriteFailureAt: "2026-07-27T13:59:00.000Z",
      degradedReason: "agent_execution_ledger_write_failed",
    });
    expect(response.body).not.toContain("database");
    await app.close();
  });
});

function fakeRuntime({
  status = {
    enabled: true as const,
    writeFailureCount: 0,
  },
}: {
  status?: ReturnType<AgentExecutionLedgerRuntime["getStatus"]>;
} = {}): AgentExecutionLedgerRuntime {
  const repository = {
    recordEvent: vi.fn<AgentExecutionLedgerRepository["recordEvent"]>(),
    listEvents: vi.fn<AgentExecutionLedgerRepository["listEvents"]>().mockResolvedValue([]),
  } satisfies AgentExecutionLedgerRepository;
  return {
    observer: { observe: vi.fn(async () => undefined) },
    repository,
    getStatus: vi.fn(() => status),
    close: vi.fn(async () => undefined),
  };
}
