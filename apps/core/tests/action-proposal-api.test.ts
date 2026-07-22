import { describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import type {
  ActionProposalContext,
  ActionProposalRepository,
} from "../src/action-approvals/action-proposal-repository.js";
import type { ActionApprovalRuntime } from "../src/runtime/action-approval-runtime.js";

describe("action proposal internal API", () => {
  it("authenticates before parsing a body and exposes no human approval route", async () => {
    const harness = createHarness();
    const app = buildApp(harness.dependencies);

    const unauthorized = await app.inject({
      method: "PUT",
      url: "/internal/action-policies/policy-1",
      headers: { "content-type": "application/json" },
      payload: "{invalid",
    });
    expect(unauthorized.statusCode).toBe(401);
    expect(unauthorized.json()).toEqual({ ok: false, error: "internal_api_unauthorized" });

    const approval = await app.inject({
      method: "POST",
      url: "/internal/action-proposals/proposal-1/approve",
      headers: authorizedHeaders(),
      payload: {},
    });
    expect(approval.statusCode).toBe(404);

    await app.close();
  });

  it("lists bounded proposals and returns 404 for an unknown exact id", async () => {
    const harness = createHarness();
    const app = buildApp(harness.dependencies);

    const list = await app.inject({
      method: "GET",
      url: "/internal/action-proposals?status=pending_approval,approved&subjectId=draft-1&limit=25",
      headers: authorizedHeaders(),
    });
    expect(list.statusCode).toBe(200);
    expect(harness.repository.listProposals).toHaveBeenCalledWith({
      statuses: ["pending_approval", "approved"],
      subjectId: "draft-1",
      limit: 25,
    });

    harness.repository.getProposal.mockResolvedValueOnce(undefined);
    const missing = await app.inject({
      method: "GET",
      url: "/internal/action-proposals/missing",
      headers: authorizedHeaders(),
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ ok: false, error: "action_proposal_not_found" });

    await app.close();
  });

  it("applies revision governance with the operator header instead of a human approval fact", async () => {
    const harness = createHarness();
    const app = buildApp(harness.dependencies);

    const response = await app.inject({
      method: "POST",
      url: "/internal/action-proposals/proposal-1/request-revision",
      headers: { ...authorizedHeaders(), "x-iris-operator": "operator@example.com" },
      payload: {
        expectedProposalVersion: 4,
        expectedSubjectRevision: 2,
        expectedSubjectVersion: 7,
        reason: "Clarify the rollback owner.",
        operationKey: "governance:proposal-1:revision:4",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(harness.repository.applyGovernanceDisposition).toHaveBeenCalledWith({
      proposalId: "proposal-1",
      expectedProposalVersion: 4,
      expectedSubjectRevision: 2,
      expectedSubjectVersion: 7,
      action: "request_revision",
      reason: "Clarify the rollback owner.",
      operationKey: "governance:proposal-1:revision:4",
      operator: "operator@example.com",
      at: expect.any(Date),
    });
    expect(harness.repository.applyApprovalAction).not.toHaveBeenCalled();

    await app.close();
  });

  it("requires exact versioned policy and role-grant writes", async () => {
    const harness = createHarness();
    const app = buildApp(harness.dependencies);
    const headers = { ...authorizedHeaders(), "x-iris-operator": "operator@example.com" };

    const policy = await app.inject({
      method: "PUT",
      url: "/internal/action-policies/policy-1",
      headers,
      payload: {
        spaceId: "space-1",
        displayName: "Approved company wiki",
        allowedGroupIds: ["oc_pilot"],
        allowedRiskLevels: ["low", "medium"],
        enabled: true,
        expectedVersion: 0,
        operationKey: "policy:policy-1:create",
      },
    });
    expect(policy.statusCode).toBe(200);
    expect(harness.repository.upsertTargetPolicy).toHaveBeenCalledWith(expect.objectContaining({
      id: "policy-1",
      expectedVersion: 0,
      operator: "operator@example.com",
    }));

    const grant = await app.inject({
      method: "PUT",
      url: "/internal/action-role-grants/iris_admin/ou_admin",
      headers,
      payload: {
        enabled: true,
        expectedVersion: 0,
        operationKey: "grant:iris_admin:ou_admin:create",
      },
    });
    expect(grant.statusCode).toBe(200);
    expect(harness.repository.upsertRoleGrant).toHaveBeenCalledWith(expect.objectContaining({
      roleType: "iris_admin",
      actorOpenId: "ou_admin",
      expectedVersion: 0,
      operator: "operator@example.com",
    }));

    await app.close();
  });

  it("returns content-free runtime status", async () => {
    const harness = createHarness();
    const app = buildApp(harness.dependencies);
    const response = await app.inject({
      method: "GET",
      url: "/internal/action-approvals/status",
      headers: authorizedHeaders(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, enabled: true, running: true });
    expect(response.body).not.toMatch(/draft content|rollback owner/iu);

    await app.close();
  });
});

function authorizedHeaders() {
  return { authorization: "Bearer operator-secret" };
}

function createHarness() {
  const repository = {
    listProposals: vi.fn(async () => []),
    getProposal: vi.fn(async (): Promise<ActionProposalContext | undefined> => ({
      proposal: proposal(),
      requirements: [],
      approvals: [],
    })),
    listEvents: vi.fn(async () => []),
    listTargetPolicies: vi.fn(async () => []),
    listRoleGrants: vi.fn(async () => []),
    upsertTargetPolicy: vi.fn(async () => ({ outcome: "applied", policy: {} })),
    upsertRoleGrant: vi.fn(async () => ({ outcome: "applied", grant: {} })),
    applyGovernanceDisposition: vi.fn(async () => ({
      outcome: "applied",
      action: "request_revision",
      proposal: proposal({ status: "cancelled", version: 5 }),
      draftStatus: "needs_revision",
      draftVersion: 8,
    })),
    applyApprovalAction: vi.fn(),
  };
  const runtime = {
    repository: repository as unknown as ActionProposalRepository,
    canUseActionApprovalsForSourceGroup: vi.fn(() => true),
    start: vi.fn(async () => undefined),
    getStatus: vi.fn(async () => ({
      enabled: true as const,
      running: true,
      enabledGroupCount: 1,
      planner: { running: true, intervalMs: 1000, batchLimit: 10 },
      dispatcher: { running: true, intervalMs: 1000, batchLimit: 10 },
      proposals: {
        pending_approval: 0,
        approved: 0,
        executing: 0,
        succeeded: 0,
        failed: 0,
        cancelled: 0,
        expired: 0,
        reconciliation_required: 0,
      },
      outbox: {
        pending: 0,
        processing: 0,
        external_attempting: 0,
        sent: 0,
        failed: 0,
        outcome_unknown: 0,
        terminalFailed: 0,
      },
    })),
    close: vi.fn(async () => undefined),
  } satisfies ActionApprovalRuntime;
  return {
    repository,
    runtime,
    dependencies: {
      internalApiToken: "operator-secret",
      createAnswerDraftRuntime: () => undefined,
      createReindexWorkerRuntime: () => undefined,
      createMemoryExtractionRuntime: () => undefined,
      createKnowledgeDraftRuntime: () => undefined,
      createKnowledgeCardRuntime: () => undefined,
      createActionApprovalRuntime: () => runtime,
      createEventWorkerRuntime: () => undefined,
      createDocumentSyncRuntime: () => undefined,
    },
  };
}

function proposal(overrides: Record<string, unknown> = {}) {
  const at = new Date("2026-07-20T05:00:00.000Z");
  return {
    id: "proposal-1",
    actionType: "publish_knowledge_draft" as const,
    subjectType: "knowledge_draft" as const,
    subjectId: "draft-1",
    subjectRevision: 2,
    subjectVersion: 7,
    targetPolicyId: "policy-1",
    targetPolicyVersion: 3,
    riskLevel: "medium" as const,
    status: "pending_approval" as const,
    operationKey: "proposal:create:1",
    version: 4,
    createdAt: at,
    updatedAt: at,
    ...overrides,
  };
}
