import { describe, expect, it, vi } from "vitest";

import { canonicalManagedBodyHash } from "../src/action-approvals/managed-knowledge-page.js";
import {
  createManagedKnowledgeUpdateReconciler,
} from "../src/action-approvals/managed-knowledge-update-reconciler.js";
import type { ManagedKnowledgeUpdater } from
  "../src/action-approvals/feishu-managed-knowledge-updater.js";
import type { ClaimedManagedKnowledgeUpdate, ManagedKnowledgePageRepository } from
  "../src/action-approvals/managed-knowledge-page-repository.js";

const at = new Date("2026-08-21T03:00:00.000Z");
const oldHash = canonicalManagedBodyHash("Old approved body");
const proposedHash = canonicalManagedBodyHash("New approved body");

describe("ManagedKnowledgeUpdateReconciler", () => {
  it.each([
    {
      name: "proposed state",
      observation: { revision: 13, blockType: "text" as const, canonicalBodyHash: proposedHash },
      expectedStatus: "applied",
      expectedUpdateCalls: 0,
    },
    {
      name: "exact old state",
      observation: { revision: 12, blockType: "text" as const, canonicalBodyHash: oldHash },
      expectedStatus: "retry_same_token",
      expectedUpdateCalls: 1,
    },
    {
      name: "human edit",
      observation: { revision: 14, blockType: "text" as const, canonicalBodyHash: "f".repeat(64) },
      expectedStatus: "reconciliation_required",
      expectedUpdateCalls: 0,
    },
  ])("reconciles $name without content similarity", async ({
    observation,
    expectedStatus,
    expectedUpdateCalls,
  }) => {
    const dependencies = reconcilerDependencies();
    dependencies.updater.readBack.mockResolvedValue(observation);
    const reconciler = createManagedKnowledgeUpdateReconciler(dependencies);

    await expect(reconciler.reconcileOne(dependencies.claim)).resolves.toMatchObject({
      status: expectedStatus,
      executionId: "execution-1",
    });

    expect(dependencies.updater.update).toHaveBeenCalledTimes(expectedUpdateCalls);
    if (expectedUpdateCalls === 1) {
      expect(dependencies.updater.update).toHaveBeenCalledWith(expect.objectContaining({
        clientToken: "9d8f9c68-9d9a-5f1c-9f5b-d4fa75c9d4ef",
        expectedRevision: 12,
      }));
    }
  });

  it("does not overwrite the exact old state after its one durable safe retry was already consumed", async () => {
    const dependencies = reconcilerDependencies();
    dependencies.updater.readBack.mockResolvedValue({
      revision: 12,
      blockType: "text",
      canonicalBodyHash: oldHash,
    });
    dependencies.managedPages.claimRemoteRetry.mockRejectedValue(new Error("retry already consumed"));
    const reconciler = createManagedKnowledgeUpdateReconciler(dependencies);

    await expect(reconciler.reconcileOne(dependencies.claim)).resolves.toMatchObject({
      status: "reconciliation_required",
      code: "safe_retry_not_claimed",
    });
    expect(dependencies.updater.update).not.toHaveBeenCalled();
  });

  it("discovers stale dispatched work by cutoff and continues reconciliation without runtime capability gates", async () => {
    const dependencies = reconcilerDependencies();
    dependencies.managedPages.listReconciliationRequired.mockResolvedValue([dependencies.claim]);
    const reconciler = createManagedKnowledgeUpdateReconciler({
      ...dependencies,
      staleDispatchMs: 60_000,
    });

    await reconciler.processBatch({ limit: 5 });

    expect(dependencies.managedPages.listReconciliationRequired).toHaveBeenCalledWith({
      limit: 5,
      dispatchedBefore: new Date("2026-08-21T02:59:00.000Z"),
      claimedBefore: new Date("2026-08-21T02:59:00.000Z"),
    });
  });

  it("recovers a stale post-claim crash only after exact preflight and durable dispatch", async () => {
    const dependencies = reconcilerDependencies();
    dependencies.claim.execution = {
      ...dependencies.claim.execution,
      state: "claimed",
      version: 1,
    };
    dependencies.claim.page = {
      ...dependencies.claim.page,
      state: "updating",
      version: 2,
    };
    dependencies.claim.proposal = {
      ...dependencies.claim.proposal,
      status: "executing",
      version: 4,
    };
    dependencies.updater.preflight.mockResolvedValue({
      revision: 12,
      blockType: "text",
      canonicalBodyHash: oldHash,
    });
    const reconciler = createManagedKnowledgeUpdateReconciler(dependencies);

    await expect(reconciler.reconcileOne(dependencies.claim)).resolves.toMatchObject({
      status: "applied",
      code: "stale_claim_applied",
    });

    expect(dependencies.updater.preflight.mock.invocationCallOrder[0])
      .toBeLessThan(dependencies.managedPages.markRemoteRequestDispatched.mock.invocationCallOrder[0]!);
    expect(dependencies.managedPages.markRemoteRequestDispatched).toHaveBeenCalledWith(
      expect.objectContaining({ executionId: "execution-1", expectedExecutionVersion: 1 }),
    );
    expect(dependencies.updater.update).toHaveBeenCalledWith(expect.objectContaining({
      clientToken: "9d8f9c68-9d9a-5f1c-9f5b-d4fa75c9d4ef",
    }));
  });

  it("bars a stale claimed execution whose exact preflight no longer matches", async () => {
    const dependencies = reconcilerDependencies();
    dependencies.claim.execution = { ...dependencies.claim.execution, state: "claimed", version: 1 };
    dependencies.claim.page = { ...dependencies.claim.page, state: "updating", version: 2 };
    dependencies.updater.preflight.mockResolvedValue({
      revision: 13,
      blockType: "text",
      canonicalBodyHash: proposedHash,
    });
    const reconciler = createManagedKnowledgeUpdateReconciler(dependencies);

    await expect(reconciler.reconcileOne(dependencies.claim)).resolves.toMatchObject({
      status: "reconciliation_required",
      code: "stale_claim_preflight_mismatch",
    });
    expect(dependencies.managedPages.recordRemoteOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        classification: "preflight_failed",
        pageDisposition: "reconciliation_required",
      }),
    );
    expect(dependencies.managedPages.markRemoteRequestDispatched).not.toHaveBeenCalled();
    expect(dependencies.updater.update).not.toHaveBeenCalled();
  });

  it("claims one same-token retry for stale dispatched exact-old readback using the durable cutoff", async () => {
    const dependencies = reconcilerDependencies();
    dependencies.claim.execution = {
      ...dependencies.claim.execution,
      state: "remote_request_dispatched",
      remoteRequestDispatchedAt: new Date("2026-08-21T02:58:00.000Z"),
    };
    dependencies.updater.readBack.mockResolvedValue({
      revision: 12,
      blockType: "text",
      canonicalBodyHash: oldHash,
    });
    const reconciler = createManagedKnowledgeUpdateReconciler(dependencies);

    await expect(reconciler.reconcileOne(dependencies.claim)).resolves.toMatchObject({
      status: "retry_same_token",
    });
    expect(dependencies.managedPages.claimRemoteRetry).toHaveBeenCalledWith(expect.objectContaining({
      executionId: "execution-1",
      staleDispatchedBefore: new Date("2026-08-21T02:59:00.000Z"),
    }));
  });

  it("re-enqueues durable remote_applied work without another remote mutation or readback", async () => {
    const dependencies = reconcilerDependencies();
    dependencies.claim.execution = {
      ...dependencies.claim.execution,
      state: "remote_applied",
      responseRevisionId: "13",
    };
    const reconciler = createManagedKnowledgeUpdateReconciler(dependencies);

    await expect(reconciler.reconcileOne(dependencies.claim)).resolves.toMatchObject({
      status: "applied",
      code: "resync_enqueued",
    });

    expect(dependencies.updater.readBack).not.toHaveBeenCalled();
    expect(dependencies.updater.update).not.toHaveBeenCalled();
    expect(dependencies.syncQueue.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      documentSourceId: "source-1",
    }));
  });

  it("keeps a newly confirmed remote apply barred when the exact resync enqueue fails", async () => {
    const dependencies = reconcilerDependencies();
    dependencies.syncQueue.enqueue.mockRejectedValue(new Error("queue unavailable"));
    const reconciler = createManagedKnowledgeUpdateReconciler(dependencies);

    await expect(reconciler.reconcileOne(dependencies.claim)).resolves.toMatchObject({
      status: "reconciliation_required",
      code: "resync_enqueue_failed",
    });

    expect(dependencies.managedPages.recordRemoteOutcome).toHaveBeenNthCalledWith(2,
      expect.objectContaining({
        executionId: "execution-1",
        expectedExecutionVersion: 4,
        classification: "reconciliation_required",
        pageDisposition: "reconciliation_required",
        responseRevisionId: "13",
        reconciliationReasonCode: "resync_enqueue_failed",
      }));
  });

  it("completes an observation that arrived before the remote outcome commit after applied becomes durable", async () => {
    const dependencies = reconcilerDependencies();
    dependencies.claim.execution = {
      ...dependencies.claim.execution,
      state: "remote_applied",
      responseRevisionId: "13",
    };
    dependencies.managedPages.findResyncReadyExecution.mockResolvedValue({
      executionId: "execution-1",
      executionVersion: 3,
      managedPageVersion: 3,
      observationId: "observation-early",
    });
    const reconciler = createManagedKnowledgeUpdateReconciler(dependencies);

    await reconciler.reconcileOne(dependencies.claim);

    expect(dependencies.managedPages.completeResync).toHaveBeenCalledWith({
      executionId: "execution-1",
      expectedExecutionVersion: 3,
      expectedManagedPageVersion: 3,
      observationId: "observation-early",
      operationKey: expect.stringMatching(/^managed-update-resync-complete:[0-9a-f]{64}$/u),
      actor: "managed-update-reconciler-1",
      at,
    });
  });
});

function reconcilerDependencies() {
  const proposal = {
    id: "proposal-1", actionType: "update_knowledge_publication" as const,
    subjectType: "knowledge_draft" as const, subjectId: "draft-1", subjectRevision: 1,
    subjectVersion: 4, targetPolicyId: "policy-1", targetPolicyVersion: 3,
    riskLevel: "low" as const, status: "reconciliation_required" as const,
    operationKey: "proposal-op", version: 4, createdAt: at, updatedAt: at,
  };
  const claim: ClaimedManagedKnowledgeUpdate = {
    outcome: "applied" as const,
    proposal,
    draft: {
      id: "draft-1", sourceGroupId: "group-1", revisionNumber: 1, version: 4,
      content: "New approved body", riskLevel: "low" as const,
    },
    page: {
      id: "managed-1", originKnowledgePublicationId: "publication-1",
      targetPolicyId: "policy-1", targetPolicyVersion: 3, authorizationGroupId: "group-1",
      remoteNodeToken: "node-1", remoteDocumentToken: "docx-1", managedBodyBlockId: "blk_body",
      linkedDocumentSourceId: "source-1", currentRemoteRevisionId: "12",
      currentBodyContentHash: oldHash, state: "reconciliation_required" as const, version: 3,
      createdAt: at, updatedAt: at,
    },
    target: {
      id: "target-1", draftId: "draft-1", draftRevision: 1, draftVersion: 1,
      conflictCandidateId: "candidate-1", conflictCandidateVersion: 5,
      managedPageId: "managed-1", managedPageVersion: 1, linkedDocumentSourceId: "source-1",
      targetSnapshotId: "snapshot-old", targetSnapshotHash: "a".repeat(64),
      remoteDocumentToken: "docx-1", managedBodyBlockId: "blk_body",
      expectedRemoteRevisionId: "12", currentBodyContentHash: oldHash,
      proposedBodyContentHash: proposedHash, authorizationGroupId: "group-1",
      targetPolicyId: "policy-1", targetPolicyVersion: 3, operationKey: "target-op", createdAt: at,
    },
    execution: {
      id: "execution-1", proposalId: "proposal-1", managedPageId: "managed-1",
      approvalId: "approval-1", executorId: "managed-update-worker-1",
      managedPageVersion: 2, updateTargetId: "target-1", attemptNumber: 1,
      state: "outcome_unknown" as "claimed" | "outcome_unknown" | "remote_applied" | "remote_request_dispatched",
      operationKey: "execution-op", requestFingerprint: "b".repeat(64),
      expectedRemoteRevisionId: "12", beforeBodyContentHash: oldHash,
      afterBodyContentHash: proposedHash,
      clientToken: "9d8f9c68-9d9a-5f1c-9f5b-d4fa75c9d4ef",
      reconciliationReasonCode: "timeout", version: 3, createdAt: at, updatedAt: at,
      responseRevisionId: undefined as string | undefined,
      remoteRequestDispatchedAt: undefined as Date | undefined,
    },
  };
  const managedPages = {
    listReconciliationRequired: vi.fn<ManagedKnowledgePageRepository["listReconciliationRequired"]>(async () => []),
    markRemoteRequestDispatched: vi.fn<ManagedKnowledgePageRepository["markRemoteRequestDispatched"]>(async (input) => ({
      outcome: "applied" as const,
      page: claim.page,
      execution: {
        ...claim.execution,
        state: "remote_request_dispatched" as const,
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
    recordRemoteOutcome: vi.fn<ManagedKnowledgePageRepository["recordRemoteOutcome"]>(async (input) => ({
      outcome: "applied" as const,
      page: claim.page,
      execution: {
        ...claim.execution,
        state: input.classification,
        version: input.expectedExecutionVersion + 1,
        responseRevisionId: input.classification === "remote_applied" ? "13" : undefined,
      },
    })),
    findResyncReadyExecution: vi.fn<ManagedKnowledgePageRepository["findResyncReadyExecution"]>(async () => undefined),
    completeResync: vi.fn<ManagedKnowledgePageRepository["completeResync"]>(async () => ({
      outcome: "applied" as const,
      page: { ...claim.page, state: "active" as const, version: claim.page.version + 1 },
      execution: { ...claim.execution, state: "succeeded" as const, version: claim.execution.version + 1 },
    })),
  };
  const updater = {
    preflight: vi.fn(),
    readBack: vi.fn<ManagedKnowledgeUpdater["readBack"]>(async () => ({ revision: 13, blockType: "text" as const, canonicalBodyHash: proposedHash })),
    update: vi.fn<ManagedKnowledgeUpdater["update"]>(async () => ({ kind: "applied" as const, resultingRevision: 13 })),
  };
  return {
    claim,
    managedPages,
    updater,
    syncQueue: { enqueue: vi.fn(async () => undefined) },
    workerId: "managed-update-reconciler-1",
    staleDispatchMs: 60_000,
    now: () => at,
  };
}
