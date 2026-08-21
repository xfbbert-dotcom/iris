import { describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import { RuntimeController } from "../src/admin/runtime-controller.js";
import { createDefaultRuntimeConfig } from "../src/config/runtime-config.js";
import type {
  ActionProposalContext,
  ActionProposalRepository,
} from "../src/action-approvals/action-proposal-repository.js";
import type { ActionApprovalRuntime } from "../src/runtime/action-approval-runtime.js";
import { createActionApprovalRuntime } from "../src/runtime/action-approval-runtime.js";
import { ManagedKnowledgePageOperationConflictError } from
  "../src/action-approvals/postgres-managed-knowledge-page-repository.js";

describe("action proposal internal API", () => {
  it("authenticates before parsing a body and exposes no human approval route", async () => {
    const harness = createHarness();
    const app = await buildApp(harness.dependencies);

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
    const app = await buildApp(harness.dependencies);

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
    const app = await buildApp(harness.dependencies);

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
    const app = await buildApp(harness.dependencies);
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
    const app = await buildApp(harness.dependencies);
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

  it("returns managed-update metadata without draft, document, token, or remote-error content", async () => {
    const harness = createHarness();
    harness.managedKnowledgeAdmin.getProposalMetadata.mockResolvedValueOnce({
      managedTarget: {
        id: "target-1",
        expectedRevision: "13",
        currentBodyHash: "a".repeat(64),
        proposedBodyHash: "b".repeat(64),
        state: "reconciliation_required",
        draftBody: "Approved body",
      },
      page: {
        id: "page-1",
        sourceId: "source-1",
        state: "reconciliation_required",
        version: 8,
        safeWikiUrl: "https://www.feishu.cn/wiki/wiki-node-1",
        documentToken: "docx_secret",
      },
      executions: [{
        id: "execution-1",
        state: "outcome_unknown",
        version: 4,
        requestFingerprint: "f".repeat(64),
        reasonCode: "timeout",
        createdAt: new Date("2026-08-20T00:00:00.000Z"),
        updatedAt: new Date("2026-08-20T00:01:00.000Z"),
        events: [{ type: "outcome_unknown", toVersion: 4, reasonCode: "timeout",
          at: new Date("2026-08-20T00:01:00.000Z") }],
        rawRemoteError: "raw timeout body",
        accessToken: "tenant-token",
      }],
    });
    const app = await buildApp(harness.dependencies);

    const response = await app.inject({
      method: "GET",
      url: "/internal/action-proposals/proposal-1",
      headers: authorizedHeaders(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      managedTarget: { state: "reconciliation_required", expectedRevision: "13" },
      managedPage: { id: "page-1", safeWikiUrl: "https://www.feishu.cn/wiki/wiki-node-1" },
      managedExecutions: [{ id: "execution-1", reasonCode: "timeout" }],
    });
    expect(response.body).not.toMatch(/Approved body|Proposed body|docx_secret|blk_secret|tenant-token|raw timeout body/iu);
    await app.close();
  });

  it("requires the operator identity and exact versions for a reconciliation request", async () => {
    const harness = createHarness();
    harness.managedKnowledgeAdmin.reconcile.mockResolvedValueOnce({
      executionId: "execution-1",
      state: "reconciliation_required",
      version: 5,
      reasonCode: "readback_unavailable",
    });
    const app = await buildApp(harness.dependencies);

    const missingOperator = await app.inject({
      method: "POST",
      url: "/internal/managed-knowledge-updates/execution-1/reconcile",
      headers: authorizedHeaders(),
      payload: { expectedExecutionVersion: 4, expectedManagedPageVersion: 8, operationKey: "reconcile:1" },
    });
    expect(missingOperator.statusCode).toBe(400);

    const response = await app.inject({
      method: "POST",
      url: "/internal/managed-knowledge-updates/execution-1/reconcile",
      headers: { ...authorizedHeaders(), "x-iris-operator": "operator@example.com" },
      payload: { expectedExecutionVersion: 4, expectedManagedPageVersion: 8, operationKey: "reconcile:1" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      execution: {
        executionId: "execution-1",
        state: "reconciliation_required",
        version: 5,
        reasonCode: "readback_unavailable",
      },
    });
    expect(harness.managedKnowledgeAdmin.reconcile).toHaveBeenCalledWith({
      executionId: "execution-1",
      expectedExecutionVersion: 4,
      expectedManagedPageVersion: 8,
      operationKey: "reconcile:1",
      operator: "operator@example.com",
      at: expect.any(Date),
    });
    await app.close();
  });

  it("keeps an exact reconciliation operation replay idempotent at the API boundary", async () => {
    const harness = createHarness();
    const runtimeProducer = runtimeBackedReconciliationProducer();
    let serverTime = Date.parse("2026-08-22T00:00:00.000Z");
    const app = await buildApp({
      ...harness.dependencies,
      now: () => new Date(serverTime += 1_000),
      createActionApprovalRuntime: () => runtimeProducer.runtime,
    });
    const request = {
      method: "POST" as const,
      url: "/internal/managed-knowledge-updates/execution-1/reconcile",
      headers: { ...authorizedHeaders(), "x-iris-operator": "operator@example.com" },
      payload: { expectedExecutionVersion: 4, expectedManagedPageVersion: 8, operationKey: "reconcile:replay" },
    };

    const first = await app.inject(request);
    const replay = await app.inject(request);
    expect(first.json()).toEqual(replay.json());
    expect(runtimeProducer.requestReconciliation).toHaveBeenCalledTimes(2);
    const firstAt = runtimeProducer.requestReconciliation.mock.calls[0]?.[0].at as Date;
    const replayAt = runtimeProducer.requestReconciliation.mock.calls[1]?.[0].at as Date;
    expect(replayAt.getTime()).toBeGreaterThan(firstAt.getTime());
    expect(runtimeProducer.reconcileOne).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("returns an operation conflict for a reconciliation key replay with a different version fingerprint", async () => {
    const harness = createHarness();
    harness.managedKnowledgeAdmin.reconcile.mockRejectedValueOnce(
      new ManagedKnowledgePageOperationConflictError(),
    );
    const app = await buildApp(harness.dependencies);

    const response = await app.inject({
      method: "POST",
      url: "/internal/managed-knowledge-updates/execution-1/reconcile",
      headers: { ...authorizedHeaders(), "x-iris-operator": "operator@example.com" },
      payload: { expectedExecutionVersion: 5, expectedManagedPageVersion: 8, operationKey: "reconcile:replay" },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ ok: false, error: "action_proposal_operation_conflict" });
    await app.close();
  });
});

function authorizedHeaders() {
  return { authorization: "Bearer operator-secret" };
}

function runtimeBackedReconciliationProducer() {
  const acknowledgement = {
    executionId: "execution-1", state: "reconciliation_required" as const, version: 5,
    reasonCode: "operator_requested" as const,
  };
  const claim = { execution: { id: "execution-1", version: 5 } };
  const requestReconciliation = vi.fn()
    .mockResolvedValueOnce({ outcome: "applied", claim, acknowledgement })
    .mockResolvedValueOnce({ outcome: "already_applied", claim, acknowledgement });
  const reconcileOne = vi.fn(async () => ({
    executionId: "execution-1", status: "resync_required" as const, code: "readback_confirmed",
  }));
  const loop = { start: vi.fn(), stop: vi.fn(async () => undefined), isRunning: vi.fn(() => false), getSnapshot: vi.fn(() => ({ running: false, intervalMs: 1_000, batchLimit: 10 })) };
  const runtime = createActionApprovalRuntime({
    env: {
      IRIS_APPROVAL_ACTIONS_ENABLED: "true", IRIS_APPROVAL_ACTION_GROUP_IDS: "oc_pilot",
      DATABASE_URL: "postgres://iris:secret@postgres:5432/iris", FEISHU_APP_ID: "app-id", FEISHU_APP_SECRET: "app-secret",
    },
    runtimeController: new RuntimeController(createDefaultRuntimeConfig()),
    knowledgeCardRuntime: {
      approvalInteractions: { cardClient: {}, membershipChecker: {}, botOpenId: "ou_irisbot" },
      bindActionApprovalWorker: vi.fn(), bindKnowledgeConflictInteractionWorker: vi.fn(),
    } as never,
    dependencies: {
      createPostgresPool: () => ({ query: async () => ({ rows: [{ present: true, outcome_unknown: 0, reconciliation_required: 0 }] }), end: async () => undefined }),
      createRepository: () => ({ getStatusCounts: async () => ({}), getApprovalOutboxStatusCounts: async () => ({}) }),
      createPlanner: () => ({}), createDispatcher: () => ({}), createActionWorker: () => ({}),
      createFeishuTenantAccessTokenProvider: () => ({}), createPublicationPublisher: () => ({}), createPublicationExecutor: () => ({}),
      createPlannerLoop: () => loop, createDispatcherLoop: () => loop, createPublicationExecutorLoop: () => loop,
      createManagedPageRepository: () => ({ requestReconciliation, getMetadataForProposal: async () => undefined }),
      createManagedBlockReader: () => ({}), createManagedUpdater: () => ({}), createManagedUpdateExecutor: () => ({}),
      createManagedUpdateReconciler: () => ({ reconcileOne }), createManagedUpdateLoop: () => loop,
    } as never,
    managedKnowledgeUpdates: {
      deploymentEnabled: true, groupAllowlist: ["oc_pilot"], syncQueue: { enqueue: async () => undefined },
      intervalMs: 1_000, batchLimit: 10, staleDispatchMs: 60_000,
    },
  })!;
  return { runtime, requestReconciliation, reconcileOne };
}

function createHarness() {
  const managedKnowledgeAdmin = {
    getProposalMetadata: vi.fn(async () => undefined),
    reconcile: vi.fn(async () => undefined),
  } as any;
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
    managedKnowledgeAdmin,
    canUseActionApprovalsForSourceGroup: vi.fn(() => true),
    start: vi.fn(async () => undefined),
    getStatus: vi.fn(async () => ({
      enabled: true as const,
      running: true,
      enabledGroupCount: 1,
      planner: { running: true, intervalMs: 1000, batchLimit: 10 },
      dispatcher: { running: true, intervalMs: 1000, batchLimit: 10 },
      publicationExecutor: { running: true, intervalMs: 1000, batchLimit: 10 },
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
    managedKnowledgeAdmin,
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
