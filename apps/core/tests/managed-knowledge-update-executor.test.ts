import { describe, expect, it, vi } from "vitest";

import type { AgentExecutionObserver } from "../src/agent-runtime/agent-execution-observer.js";
import { canonicalManagedBodyHash } from "../src/action-approvals/managed-knowledge-page.js";
import {
  createManagedKnowledgeUpdateExecutor,
  type ManagedKnowledgeUpdateExecutorDependencies,
} from "../src/action-approvals/managed-knowledge-update-executor.js";
import type { ManagedKnowledgeUpdater } from
  "../src/action-approvals/feishu-managed-knowledge-updater.js";
import type { ManagedKnowledgePageRepository } from
  "../src/action-approvals/managed-knowledge-page-repository.js";

const at = new Date("2026-08-21T01:00:00.000Z");
const oldBody = "Old approved body";
const proposedBody = "New approved body";
const oldHash = canonicalManagedBodyHash(oldBody);
const proposedHash = canonicalManagedBodyHash(proposedBody);

describe("ManagedKnowledgeUpdateExecutor", () => {
  it("requires every deployment, runtime, capability, and allowlist gate before listing", async () => {
    const snapshots = [
      runtimeSnapshot({ deploymentEnabled: false }),
      runtimeSnapshot({ globalEnabled: false }),
      runtimeSnapshot({ writeKnowledgeBase: false }),
      runtimeSnapshot({ updateManagedKnowledge: false }),
      runtimeSnapshot({ groupAllowlist: [] }),
      runtimeSnapshot({ disabledGroupIds: ["group-1"] }),
    ];

    for (const snapshot of snapshots) {
      const dependencies = executorDependencies();
      const executor = createManagedKnowledgeUpdateExecutor({
        ...dependencies,
        runtimeSnapshot: () => snapshot,
      });

      await expect(executor.processBatch({ limit: 10 })).resolves.toEqual([]);
      expect(dependencies.proposals.listProposals).not.toHaveBeenCalled();
      expect(dependencies.managedPages.claimApprovedUpdate).not.toHaveBeenCalled();
      expect(dependencies.updater.preflight).not.toHaveBeenCalled();
    }
  });

  it("filters approved update proposals by an enabled allowlist before LIMIT and activates the barrier before preflight", async () => {
    const order: string[] = [];
    const dependencies = executorDependencies({ order });
    const executor = createManagedKnowledgeUpdateExecutor(dependencies);

    await executor.processBatch({ limit: 1 });

    expect(dependencies.proposals.listProposals).toHaveBeenCalledWith({
      statuses: ["approved"],
      actionTypes: ["update_knowledge_publication"],
      authorizationGroupIds: ["group-1"],
      limit: 1,
    });
    expect(order.slice(0, 2)).toEqual(["claim-and-barrier", "remote-preflight"]);
    expect(dependencies.managedPages.claimApprovedUpdate).toHaveBeenCalledWith({
      proposalId: "proposal-1",
      expectedProposalVersion: 2,
      runtimeGate: {
        deploymentEnabled: true,
        globalEnabled: true,
        writeKnowledgeBase: true,
        updateManagedKnowledge: true,
        disabledGroupIds: [],
        allowedGroupIds: ["group-1"],
      },
      workerId: "managed-update-worker-1",
      operationKey: expect.stringMatching(/^managed-update-claim:[0-9a-f]{64}$/u),
      at,
    });
  });

  it("rejects a claimed execution whose exact durable tuple is inconsistent before remote preflight", async () => {
    const dependencies = executorDependencies();
    dependencies.claim.execution.afterBodyContentHash = "f".repeat(64);
    const executor = createManagedKnowledgeUpdateExecutor(dependencies);

    await expect(executor.processBatch({ limit: 1 })).resolves.toEqual([{
      status: "failed",
      proposalId: "proposal-1",
      executionId: "execution-1",
      code: "claim_binding_mismatch",
    }]);
    expect(dependencies.updater.preflight).not.toHaveBeenCalled();
    expect(dependencies.updater.update).not.toHaveBeenCalled();
  });

  it("reports a durably terminalized competing proposal without any remote call", async () => {
    const dependencies = executorDependencies();
    dependencies.managedPages.claimApprovedUpdate.mockResolvedValue({
      outcome: "terminal",
      proposalId: "proposal-1",
      proposalVersion: 3,
      code: "competing_execution",
    } as never);
    const executor = createManagedKnowledgeUpdateExecutor(dependencies);

    await expect(executor.processBatch({ limit: 1 })).resolves.toEqual([{
      status: "failed",
      proposalId: "proposal-1",
      code: "competing_execution",
    }]);
    expect(dependencies.updater.preflight).not.toHaveBeenCalled();
    expect(dependencies.updater.update).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "revision changed",
      observation: { revision: 13, blockType: "text" as const, canonicalBodyHash: oldHash },
      code: "preflight_revision_mismatch",
    },
    {
      name: "body changed",
      observation: { revision: 12, blockType: "text" as const, canonicalBodyHash: "f".repeat(64) },
      code: "preflight_body_mismatch",
    },
    {
      name: "non-positive revision",
      observation: { revision: 0, blockType: "text" as const, canonicalBodyHash: oldHash },
      code: "preflight_revision_invalid",
    },
  ])("bars stale content without mutation when $name", async ({ observation, code }) => {
    const dependencies = executorDependencies();
    dependencies.updater.preflight.mockResolvedValue(observation);
    const executor = createManagedKnowledgeUpdateExecutor(dependencies);

    await expect(executor.processBatch({ limit: 1 })).resolves.toEqual([{
      status: "failed",
      proposalId: "proposal-1",
      executionId: "execution-1",
      code,
    }]);

    expect(dependencies.updater.update).not.toHaveBeenCalled();
    expect(dependencies.managedPages.markRemoteRequestDispatched).not.toHaveBeenCalled();
    expect(dependencies.managedPages.recordRemoteOutcome).toHaveBeenCalledWith({
      executionId: "execution-1",
      expectedExecutionVersion: 1,
      classification: "preflight_failed",
      pageDisposition: "reconciliation_required",
      responseClassification: code,
      reconciliationReasonCode: code,
      operationKey: expect.stringMatching(/^managed-update-preflight-failed:[0-9a-f]{64}$/u),
      actor: "managed-update-worker-1",
      at,
    });
  });

  it("durably marks dispatch before mutation, records applied, and enqueues only the exact linked source", async () => {
    const dependencies = executorDependencies();
    const executor = createManagedKnowledgeUpdateExecutor(dependencies);

    await expect(executor.processBatch({ limit: 1 })).resolves.toEqual([{
      status: "resync_required",
      proposalId: "proposal-1",
      executionId: "execution-1",
      code: "remote_applied",
    }]);

    expect(dependencies.managedPages.markRemoteRequestDispatched.mock.invocationCallOrder[0])
      .toBeLessThan(dependencies.updater.update.mock.invocationCallOrder[0]);
    expect(dependencies.updater.update).toHaveBeenCalledWith({
      remoteDocumentToken: "docx-1",
      managedBodyBlockId: "blk_body",
      expectedRevision: 12,
      proposedBody,
      clientToken: "9d8f9c68-9d9a-5f1c-9f5b-d4fa75c9d4ef",
    });
    expect(dependencies.managedPages.recordRemoteOutcome).toHaveBeenCalledWith({
      executionId: "execution-1",
      expectedExecutionVersion: 2,
      classification: "remote_applied",
      pageDisposition: "resync_required",
      responseClassification: "applied",
      responseRevisionId: "13",
      operationKey: expect.stringMatching(/^managed-update-remote-applied:[0-9a-f]{64}$/u),
      actor: "managed-update-worker-1",
      at,
    });
    expect(dependencies.syncQueue.enqueue).toHaveBeenCalledWith({
      idempotencyKey: "document-sync:source-1",
      documentSourceId: "source-1",
      reason: "manual_source_sync",
      enqueuedAt: at,
      attempts: 0,
    });
  });

  it("keeps the page barred and never retries blindly when delivery is unknown", async () => {
    const dependencies = executorDependencies();
    dependencies.updater.update.mockResolvedValue({ kind: "unknown", code: "timeout" });
    const executor = createManagedKnowledgeUpdateExecutor(dependencies);

    await expect(executor.processBatch({ limit: 1 })).resolves.toEqual([{
      status: "reconciliation_required",
      proposalId: "proposal-1",
      executionId: "execution-1",
      code: "timeout",
    }]);

    expect(dependencies.updater.update).toHaveBeenCalledOnce();
    expect(dependencies.updater.readBack).not.toHaveBeenCalled();
    expect(dependencies.managedPages.recordRemoteOutcome).toHaveBeenCalledWith({
      executionId: "execution-1",
      expectedExecutionVersion: 2,
      classification: "outcome_unknown",
      pageDisposition: "reconciliation_required",
      responseClassification: "timeout",
      reconciliationReasonCode: "timeout",
      operationKey: expect.stringMatching(/^managed-update-outcome-unknown:[0-9a-f]{64}$/u),
      actor: "managed-update-worker-1",
      at,
    });
    expect(dependencies.syncQueue.enqueue).not.toHaveBeenCalled();
  });

  it("retries one explicit transient response only after exact old revision/hash readback and reuses the durable token", async () => {
    const dependencies = executorDependencies();
    dependencies.updater.update
      .mockResolvedValueOnce({ kind: "not_applied_retryable", code: "rate_limited" })
      .mockResolvedValueOnce({ kind: "applied", resultingRevision: 13 });
    dependencies.updater.readBack.mockResolvedValue({
      revision: 12,
      blockType: "text",
      canonicalBodyHash: oldHash,
    });
    const executor = createManagedKnowledgeUpdateExecutor(dependencies);

    await expect(executor.processBatch({ limit: 1 })).resolves.toEqual([{
      status: "resync_required",
      proposalId: "proposal-1",
      executionId: "execution-1",
      code: "remote_applied",
    }]);

    expect(dependencies.managedPages.claimRemoteRetry).toHaveBeenCalledOnce();
    expect(dependencies.updater.update).toHaveBeenCalledTimes(2);
    expect(dependencies.updater.update.mock.calls.map(([input]) => input.clientToken)).toEqual([
      "9d8f9c68-9d9a-5f1c-9f5b-d4fa75c9d4ef",
      "9d8f9c68-9d9a-5f1c-9f5b-d4fa75c9d4ef",
    ]);
  });

  it.each([
    ["stale_revision", "reconciliation_required", "stale_revision"],
    ["forbidden", "blocked", "forbidden"],
    ["missing", "retired", "missing"],
    ["invalid", "reconciliation_required", "invalid"],
  ] as const)("maps explicit %s rejection to a safe terminal page disposition", async (
    code,
    pageDisposition,
    resultCode,
  ) => {
    const dependencies = executorDependencies();
    dependencies.updater.update.mockResolvedValue({ kind: "rejected", code });
    const executor = createManagedKnowledgeUpdateExecutor(dependencies);

    await expect(executor.processBatch({ limit: 1 })).resolves.toEqual([{
      status: "failed",
      proposalId: "proposal-1",
      executionId: "execution-1",
      code: resultCode,
    }]);
    expect(dependencies.managedPages.recordRemoteOutcome).toHaveBeenCalledWith(expect.objectContaining({
      classification: "failed",
      pageDisposition,
      responseClassification: code,
    }));
  });

  it("moves confirmed application to reconciliation when exact resync enqueue fails", async () => {
    const dependencies = executorDependencies();
    dependencies.syncQueue.enqueue.mockRejectedValue(new Error("redis unavailable with secret"));
    const executor = createManagedKnowledgeUpdateExecutor(dependencies);

    await expect(executor.processBatch({ limit: 1 })).resolves.toEqual([{
      status: "reconciliation_required",
      proposalId: "proposal-1",
      executionId: "execution-1",
      code: "resync_enqueue_failed",
    }]);

    expect(dependencies.managedPages.recordRemoteOutcome).toHaveBeenNthCalledWith(2, {
      executionId: "execution-1",
      expectedExecutionVersion: 3,
      classification: "reconciliation_required",
      pageDisposition: "reconciliation_required",
      responseClassification: "resync_enqueue_failed",
      responseRevisionId: "13",
      reconciliationReasonCode: "resync_enqueue_failed",
      operationKey: expect.stringMatching(/^managed-update-resync-enqueue-failed:[0-9a-f]{64}$/u),
      actor: "managed-update-worker-1",
      at,
    });
  });

  it("emits only content-free managed update observations", async () => {
    const observe = vi.fn<AgentExecutionObserver["observe"]>(async () => undefined);
    const dependencies = executorDependencies();
    const executor = createManagedKnowledgeUpdateExecutor({
      ...dependencies,
      agentExecutionObserver: { observe },
    });

    await executor.processBatch({ limit: 1 });

    expect(observe).toHaveBeenCalledWith(expect.objectContaining({
      toolName: "iris.knowledge.updateManagedPublication",
      subjectType: "action_execution",
      subjectId: "execution-1",
      metadata: expect.objectContaining({
        proposalId: "proposal-1",
        managedPageId: "managed-1",
        managedPageVersion: 2,
        executionVersion: expect.any(Number),
        draftRevision: 1,
        targetPolicyVersion: 3,
        reasonCode: expect.any(String),
      }),
    }));
    expect(JSON.stringify(observe.mock.calls)).not.toMatch(
      /Old approved body|New approved body|docx-1|blk_body|9d8f9c68|tenant|secret/iu,
    );
  });
});

function executorDependencies({ order = [] }: { order?: string[] } = {}) {
  const proposal = {
    id: "proposal-1",
    actionType: "update_knowledge_publication" as const,
    subjectType: "knowledge_draft" as const,
    subjectId: "draft-1",
    subjectRevision: 1,
    subjectVersion: 4,
    targetPolicyId: "policy-1",
    targetPolicyVersion: 3,
    riskLevel: "low" as const,
    status: "approved" as const,
    operationKey: "proposal-op",
    version: 2,
    createdAt: at,
    updatedAt: at,
  };
  const claim = {
    outcome: "applied" as const,
    proposal: { ...proposal, status: "executing" as const, version: 3 },
    draft: {
      id: "draft-1",
      sourceGroupId: "group-1",
      revisionNumber: 1,
      version: 4,
      content: proposedBody,
      riskLevel: "low" as const,
    },
    page: {
      id: "managed-1",
      originKnowledgePublicationId: "publication-1",
      targetPolicyId: "policy-1",
      targetPolicyVersion: 3,
      authorizationGroupId: "group-1",
      remoteNodeToken: "node-1",
      remoteDocumentToken: "docx-1",
      managedBodyBlockId: "blk_body",
      linkedDocumentSourceId: "source-1",
      currentRemoteRevisionId: "12",
      currentBodyContentHash: oldHash,
      state: "updating" as const,
      version: 2,
      createdAt: at,
      updatedAt: at,
    },
    target: {
      id: "target-1",
      draftId: "draft-1",
      draftRevision: 1,
      draftVersion: 1,
      conflictCandidateId: "candidate-1",
      conflictCandidateVersion: 5,
      managedPageId: "managed-1",
      managedPageVersion: 1,
      linkedDocumentSourceId: "source-1",
      targetSnapshotId: "snapshot-old",
      targetSnapshotHash: "a".repeat(64),
      remoteDocumentToken: "docx-1",
      managedBodyBlockId: "blk_body",
      expectedRemoteRevisionId: "12",
      currentBodyContentHash: oldHash,
      proposedBodyContentHash: proposedHash,
      authorizationGroupId: "group-1",
      targetPolicyId: "policy-1",
      targetPolicyVersion: 3,
      operationKey: "target-op",
      createdAt: at,
    },
    execution: {
      id: "execution-1",
      approvalId: "approval-1",
      executorId: "managed-update-worker-1",
      proposalId: "proposal-1",
      managedPageId: "managed-1",
      managedPageVersion: 2,
      updateTargetId: "target-1",
      attemptNumber: 1,
      state: "claimed" as const,
      operationKey: "execution-op",
      requestFingerprint: "b".repeat(64),
      expectedRemoteRevisionId: "12",
      beforeBodyContentHash: oldHash,
      afterBodyContentHash: proposedHash,
      clientToken: "9d8f9c68-9d9a-5f1c-9f5b-d4fa75c9d4ef",
      version: 1,
      createdAt: at,
      updatedAt: at,
    },
  };
  const proposals = {
    listProposals: vi.fn(async () => [proposal]),
  };
  const managedPages = {
    claimApprovedUpdate: vi.fn(async () => {
      order.push("claim-and-barrier");
      return claim;
    }),
    markRemoteRequestDispatched: vi.fn(async () => ({
      outcome: "applied" as const,
      page: claim.page,
      execution: { ...claim.execution, state: "remote_request_dispatched" as const, version: 2 },
    })),
    recordRemoteOutcome: vi.fn<ManagedKnowledgePageRepository["recordRemoteOutcome"]>(async (input) => ({
      outcome: "applied" as const,
      page: claim.page,
      execution: {
        ...claim.execution,
        state: input.classification,
        version: input.expectedExecutionVersion + 1,
      },
    })),
    claimRemoteRetry: vi.fn<ManagedKnowledgePageRepository["claimRemoteRetry"]>(async (input) => ({
      outcome: "applied" as const,
      page: claim.page,
      execution: {
        ...claim.execution,
        state: "remote_request_dispatched" as const,
        version: input.expectedExecutionVersion + 1,
      },
    })),
    findResyncReadyExecution: vi.fn(async () => undefined),
    completeResync: vi.fn(),
  };
  const updater = {
    preflight: vi.fn(async () => {
      order.push("remote-preflight");
      return { revision: 12, blockType: "text" as const, canonicalBodyHash: oldHash };
    }),
    update: vi.fn<ManagedKnowledgeUpdater["update"]>(async () => ({ kind: "applied" as const, resultingRevision: 13 })),
    readBack: vi.fn<ManagedKnowledgeUpdater["readBack"]>(),
  };
  const syncQueue = { enqueue: vi.fn(async () => undefined) };
  return {
    claim,
    proposals,
    managedPages,
    updater,
    syncQueue,
    runtimeSnapshot: () => runtimeSnapshot(),
    workerId: "managed-update-worker-1",
    now: () => at,
  } satisfies ManagedKnowledgeUpdateExecutorDependencies & { claim: typeof claim };
}

function runtimeSnapshot(overrides: Partial<{
  deploymentEnabled: boolean;
  globalEnabled: boolean;
  disabledGroupIds: string[];
  groupAllowlist: string[];
  writeKnowledgeBase: boolean;
  updateManagedKnowledge: boolean;
}> = {}) {
  return {
    deploymentEnabled: overrides.deploymentEnabled ?? true,
    globalEnabled: overrides.globalEnabled ?? true,
    disabledGroupIds: overrides.disabledGroupIds ?? [],
    groupAllowlist: overrides.groupAllowlist ?? ["group-1"],
    capabilities: {
      writeKnowledgeBase: overrides.writeKnowledgeBase ?? true,
      updateManagedKnowledge: overrides.updateManagedKnowledge ?? true,
    },
  };
}
