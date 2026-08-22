import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

import { registerFormalTaskApi } from "../src/formal-tasks/formal-task-api.js";
import type { FormalTaskRuntime } from "../src/runtime/formal-task-runtime.js";
import type { FormalTaskActionRuntime } from "../src/runtime/formal-task-action-runtime.js";

const at = new Date("2026-08-23T01:00:00.000Z");

describe("formal task internal API", () => {
  it("projects draft and execution lists to content-free metadata", async () => {
    const { app } = fixture();
    const drafts = await app.inject({ method: "GET", url: "/internal/formal-task-drafts?limit=20" });
    expect(drafts.statusCode).toBe(200);
    expect(drafts.json()).toEqual({
      ok: true,
      drafts: [{
        id: "draft-1",
        sourceGroupId: "oc_pilot",
        status: "pending_review",
        currentRevisionNumber: 2,
        version: 4,
        currentTaskSpecHash: "a".repeat(64),
        riskLevel: "high",
        evidenceStatus: "current",
        createdAt: at.toISOString(),
        updatedAt: at.toISOString(),
      }],
    });
    expect(drafts.body).not.toMatch(/secret description|ou_assignee|task title/iu);

    const executions = await app.inject({
      method: "GET",
      url: "/internal/formal-task-executions?state=outcome_unknown&proposalId=proposal-1&limit=10",
    });
    expect(executions.statusCode).toBe(200);
    expect(executions.json()).toEqual({
      ok: true,
      executions: [expect.objectContaining({
        id: "execution-1",
        proposalId: "proposal-1",
        state: "outcome_unknown",
        responseClassification: "timeout",
      })],
    });
    expect(executions.body).not.toMatch(/assignee|description|remoteTask|taskGuid|taskUrl/iu);
    await app.close();
  });

  it("applies exact operator dispositions and only reschedules an existing unknown execution", async () => {
    const { app, repository, executionRepository } = fixture();
    const disposition = {
      expectedVersion: 4,
      expectedRevision: 2,
      expectedTaskSpecHash: "a".repeat(64),
      reason: "Owner requested a correction.",
      operationKey: "operator-task-revision-1",
    };
    const revision = await app.inject({
      method: "POST",
      url: "/internal/formal-task-drafts/draft-1/request-revision",
      headers: { "x-iris-operator": "operator@example.com" },
      payload: disposition,
    });
    expect(revision.statusCode).toBe(200);
    expect(repository.requestRevision).toHaveBeenCalledWith({
      id: "draft-1",
      ...disposition,
      actor: "operator@example.com",
      at,
    });

    const reconciliation = await app.inject({
      method: "POST",
      url: "/internal/formal-task-executions/execution-1/reconcile",
      headers: { "x-iris-operator": "operator@example.com" },
      payload: {
        expectedExecutionVersion: 3,
        operationKey: "operator-task-reconcile-1",
      },
    });
    expect(reconciliation.statusCode).toBe(200);
    expect(executionRepository.requestReconciliation).toHaveBeenCalledWith({
      executionId: "execution-1",
      expectedExecutionVersion: 3,
      operationKey: "operator-task-reconcile-1",
      operator: "operator@example.com",
      at,
    });
    await app.close();
  });

  it("fails closed without configured authentication or an operator identity", async () => {
    const unavailable = fixture({ authenticationConfigured: false });
    expect((await unavailable.app.inject({
      method: "GET",
      url: "/internal/formal-task-drafts?limit=20",
    })).statusCode).toBe(503);
    await unavailable.app.close();

    const configured = fixture();
    expect((await configured.app.inject({
      method: "POST",
      url: "/internal/formal-task-executions/execution-1/reconcile",
      payload: { expectedExecutionVersion: 3, operationKey: "operator-task-reconcile-1" },
    })).statusCode).toBe(400);
    expect(configured.executionRepository.requestReconciliation).not.toHaveBeenCalled();
    await configured.app.close();
  });
});

function fixture({ authenticationConfigured = true } = {}) {
  const repository = {
    listDrafts: vi.fn(async () => [draft()]),
    getDraft: vi.fn(async () => draft()),
    requestRevision: vi.fn(async () => ({ outcome: "applied", draft: draft() })),
    rejectDraft: vi.fn(async () => ({ outcome: "applied", draft: draft() })),
  };
  const executionRepository = {
    listExecutionMetadata: vi.fn(async () => [execution()]),
    requestReconciliation: vi.fn(async () => ({
      outcome: "applied",
      executionId: "execution-1",
      state: "outcome_unknown",
      version: 4,
      retryAt: at,
    })),
  };
  const app = Fastify();
  registerFormalTaskApi(
    app,
    { repository } as unknown as FormalTaskRuntime,
    { repository: executionRepository } as unknown as FormalTaskActionRuntime,
    { authenticationConfigured, now: () => at },
  );
  return { app, repository, executionRepository };
}

function draft() {
  return {
    id: "draft-1",
    sourceGroupId: "oc_pilot",
    status: "pending_review" as const,
    currentRevisionNumber: 2,
    version: 4,
    createdBy: "ou_requester",
    currentTaskSpecHash: "a".repeat(64),
    createdAt: at,
    updatedAt: at,
    currentRevision: {
      revisionNumber: 2,
      riskLevel: "high" as const,
      author: "iris",
      taskSpecHash: "a".repeat(64),
      createdAt: at,
      evidenceState: { status: "current" as const },
      taskSpec: {
        title: "Task title",
        description: "Secret description",
        assigneeOpenId: "ou_assignee",
        sourceGroupId: "oc_pilot",
        targetPolicyId: "policy-1",
        targetPolicyVersion: 1,
      },
      evidence: [],
    },
  };
}

function execution() {
  return {
    id: "execution-1",
    proposalId: "proposal-1",
    draftId: "draft-1",
    draftRevision: 2,
    draftVersion: 4,
    targetPolicyId: "policy-1",
    targetPolicyVersion: 1,
    attemptNumber: 1,
    state: "outcome_unknown" as const,
    requestFingerprint: "b".repeat(64),
    clientTokenHash: "c".repeat(64),
    responseClassification: "timeout",
    version: 3,
    retryAt: at,
    createdAt: at,
    updatedAt: at,
  };
}
