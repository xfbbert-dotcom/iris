import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

import { registerAgentExecutionLedgerApi } from "../src/agent-runtime/agent-execution-ledger-api.js";
import type {
  AgentExecutionLedgerEvent,
  AgentExecutionLedgerRepository,
} from "../src/agent-runtime/agent-execution-ledger-repository.js";

describe("agent execution ledger API", () => {
  it("lists bounded content-free events by group", async () => {
    const event = ledgerEvent();
    const repository = repositoryWith([event]);
    const app = Fastify();
    registerAgentExecutionLedgerApi(app, { repository });

    const response = await app.inject({
      method: "GET",
      url: "/internal/agent-executions?groupId=oc_pilot&limit=20",
    });

    expect(response.statusCode).toBe(200);
    expect(repository.listEvents).toHaveBeenCalledWith({
      groupId: "oc_pilot",
      limit: 20,
    });
    expect(response.json()).toEqual({
      ok: true,
      events: [{
        ...event,
        createdAt: "2026-07-27T13:00:00.000Z",
      }],
    });
    expect(response.body).not.toMatch(
      /promptContext|answerText|rawContent|documentBody|authorization/iu,
    );
    await app.close();
  });

  it("supports exact subject and tool-call filters", async () => {
    const repository = repositoryWith([]);
    const app = Fastify();
    registerAgentExecutionLedgerApi(app, { repository });

    const bySubject = await app.inject({
      method: "GET",
      url: "/internal/agent-executions?subjectType=turn&subjectId=om_123&limit=10",
    });
    const byToolCall = await app.inject({
      method: "GET",
      url: "/internal/agent-executions?toolCallId=delivery-1&limit=5",
    });

    expect(bySubject.statusCode).toBe(200);
    expect(byToolCall.statusCode).toBe(200);
    expect(repository.listEvents).toHaveBeenNthCalledWith(1, {
      subjectType: "turn",
      subjectId: "om_123",
      limit: 10,
    });
    expect(repository.listEvents).toHaveBeenNthCalledWith(2, {
      toolCallId: "delivery-1",
      limit: 5,
    });
    await app.close();
  });

  it("rejects invalid filter pairs, blanks, unknown values, and unsafe limits", async () => {
    const repository = repositoryWith([]);
    const app = Fastify();
    registerAgentExecutionLedgerApi(app, { repository });
    const urls = [
      "/internal/agent-executions?subjectType=turn",
      "/internal/agent-executions?subjectId=om_123",
      "/internal/agent-executions?subjectType=unknown&subjectId=om_123",
      "/internal/agent-executions?groupId=%20",
      "/internal/agent-executions?limit=0",
      "/internal/agent-executions?limit=101",
      "/internal/agent-executions?limit=1.5",
    ];

    for (const url of urls) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode, url).toBe(400);
      expect(response.json()).toEqual({ ok: false, error: "invalid_request" });
    }
    expect(repository.listEvents).not.toHaveBeenCalled();
    await app.close();
  });

  it("returns unavailable or safe storage failures without querying through a missing runtime", async () => {
    const disabled = Fastify();
    registerAgentExecutionLedgerApi(disabled, undefined);
    const disabledResponse = await disabled.inject({
      method: "GET",
      url: "/internal/agent-executions?limit=10",
    });
    expect(disabledResponse.statusCode).toBe(404);
    expect(disabledResponse.json()).toEqual({
      ok: false,
      error: "agent_execution_ledger_unavailable",
    });
    await disabled.close();

    const failed = Fastify();
    registerAgentExecutionLedgerApi(failed, {
      repository: repositoryWithFailure(new Error("database secret")),
    });
    const failedResponse = await failed.inject({
      method: "GET",
      url: "/internal/agent-executions?limit=10",
    });
    expect(failedResponse.statusCode).toBe(500);
    expect(failedResponse.json()).toEqual({
      ok: false,
      error: "agent_execution_ledger_query_failed",
    });
    expect(failedResponse.body).not.toContain("database secret");
    await failed.close();
  });
});

function repositoryWith(events: AgentExecutionLedgerEvent[]) {
  return {
    recordEvent: vi.fn<AgentExecutionLedgerRepository["recordEvent"]>(),
    listEvents: vi.fn<AgentExecutionLedgerRepository["listEvents"]>().mockResolvedValue(events),
  } satisfies AgentExecutionLedgerRepository;
}

function repositoryWithFailure(error: Error): AgentExecutionLedgerRepository {
  return {
    async recordEvent() {
      throw error;
    },
    async listEvents() {
      throw error;
    },
  };
}

function ledgerEvent(): AgentExecutionLedgerEvent {
  return {
    id: "ledger-event-1",
    tenantKey: "default",
    groupId: "oc_pilot",
    actorOpenId: "ou_actor",
    subjectType: "turn",
    subjectId: "om_123",
    eventType: "turn_completed",
    phase: "completed",
    outcome: "success",
    operationKey: "turn:om_123:completed",
    metadata: {
      retrievedFragmentCount: 3,
      deniedDocumentCount: 1,
    },
    durationMs: 125,
    createdAt: new Date("2026-07-27T13:00:00.000Z"),
  };
}
