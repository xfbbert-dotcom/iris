import { describe, expect, it, vi } from "vitest";

import {
  createKnowledgePublicationExecutor,
} from "../src/action-approvals/knowledge-publication-executor.js";
import type {
  ClaimApprovedPublicationExecutionResult,
} from "../src/action-approvals/action-proposal-repository.js";
import type { ActionProposal } from "../src/action-approvals/action-proposal.js";

const at = new Date("2026-07-23T07:30:00.000Z");

describe("KnowledgePublicationExecutor", () => {
  it("claims approved proposals with the current runtime gate before publishing", async () => {
    const proposal = actionProposal();
    const claim = publicationClaim({ proposal });
    const repository = {
      listProposals: vi.fn(async () => [proposal]),
      claimApprovedPublicationExecution: vi.fn(async () => claim),
      completePublicationExecution: vi.fn(async () => ({
        outcome: "applied" as const,
        proposal: { ...proposal, status: "succeeded" as const, version: 4 },
        execution: { ...claim.execution, state: "succeeded" as const, version: 2 },
        draftStatus: "published" as const,
        draftVersion: 4,
        publication: {
          id: "publication-1",
          proposalId: proposal.id,
          executionId: claim.execution.id,
          draftId: claim.draft.id,
          revisionNumber: claim.draft.revisionNumber,
          draftVersion: claim.draft.version,
          targetPolicyId: claim.policy.id,
          targetPolicyVersion: claim.policy.version,
          spaceId: claim.policy.spaceId,
          remoteNodeToken: "wikcn_remote",
          remoteDocumentToken: "docx_remote",
          remoteDocumentType: "docx",
          remoteDocumentVersion: 12,
          contentHash: "d".repeat(64),
          permissionCheckSummary: "feishu_write_access_verified",
          operationKey: "publication-complete",
          publishedAt: at,
          createdAt: at,
        },
      })),
      failPublicationExecution: vi.fn(),
    };
    const publisher = {
      publish: vi.fn(async () => ({
        remoteNodeToken: "wikcn_remote",
        remoteDocumentToken: "docx_remote",
        remoteDocumentType: "docx" as const,
        remoteDocumentVersion: 12,
        contentHash: "d".repeat(64),
        permissionCheckSummary: "feishu_write_access_verified",
      })),
    };

    const executor = createKnowledgePublicationExecutor({
      repository,
      publisher,
      runtimeSnapshot: () => ({
        globalEnabled: true,
        disabledGroupIds: ["oc_disabled"],
        capabilities: { writeKnowledgeBase: true },
      }),
      workerId: "publication-worker-1",
      now: () => at,
    });

    await expect(executor.processBatch({ limit: 1 })).resolves.toEqual([{
      status: "published",
      proposalId: proposal.id,
      code: "publication_succeeded",
    }]);
    expect(repository.claimApprovedPublicationExecution).toHaveBeenCalledWith({
      proposalId: proposal.id,
      expectedProposalVersion: proposal.version,
      runtimeGate: {
        globalEnabled: true,
        writeKnowledgeBase: true,
        disabledGroupIds: ["oc_disabled"],
      },
      workerId: "publication-worker-1",
      operationKey: expect.stringMatching(/^publication-claim:/u),
      at,
    });
    expect(publisher.publish).toHaveBeenCalledWith({
      draft: claim.draft,
      policy: claim.policy,
      proposal: claim.proposal,
      execution: claim.execution,
    });
    expect(repository.completePublicationExecution).toHaveBeenCalledWith(expect.objectContaining({
      proposalId: proposal.id,
      executionId: claim.execution.id,
      expectedProposalVersion: claim.proposal.version,
      expectedExecutionVersion: claim.execution.version,
      expectedDraftVersion: claim.draft.version,
      expectedSubjectRevision: claim.draft.revisionNumber,
      remoteNodeToken: "wikcn_remote",
      remoteDocumentToken: "docx_remote",
      operationKey: expect.stringMatching(/^publication-complete:/u),
      at,
    }));
  });

  it("marks a claimed execution failed when publishing is rejected before completion", async () => {
    const proposal = actionProposal();
    const claim = publicationClaim({ proposal });
    const repository = {
      listProposals: vi.fn(async () => [proposal]),
      claimApprovedPublicationExecution: vi.fn(async () => claim),
      completePublicationExecution: vi.fn(),
      failPublicationExecution: vi.fn(async () => ({
        outcome: "applied" as const,
        proposal: { ...claim.proposal, status: "failed" as const, version: claim.proposal.version + 1 },
        execution: { ...claim.execution, state: "failed" as const, version: claim.execution.version + 1 },
      })),
    };
    const publisher = {
      publish: vi.fn(async () => {
        throw new Error("raw Feishu body with tenant-secret and draft text");
      }),
    };
    const executor = createKnowledgePublicationExecutor({
      repository,
      publisher,
      runtimeSnapshot: () => ({
        globalEnabled: true,
        disabledGroupIds: [],
        capabilities: { writeKnowledgeBase: true },
      }),
      workerId: "publication-worker-1",
      now: () => at,
    });

    await expect(executor.processBatch({ limit: 1 })).resolves.toEqual([{
      status: "failed",
      proposalId: proposal.id,
      code: "publisher_failed",
    }]);
    expect(repository.failPublicationExecution).toHaveBeenCalledWith({
      proposalId: claim.proposal.id,
      executionId: claim.execution.id,
      expectedProposalVersion: claim.proposal.version,
      expectedExecutionVersion: claim.execution.version,
      classification: "failed",
      responseClassification: "publisher_failed",
      operationKey: expect.stringMatching(/^publication-failed:/u),
      at,
    });
    expect(JSON.stringify(await executor.processBatch({ limit: 1 }))).not.toMatch(/tenant-secret|draft text/iu);
  });

  it("does not claim or publish while knowledge-base writing is disabled", async () => {
    const repository = {
      listProposals: vi.fn(),
      claimApprovedPublicationExecution: vi.fn(),
      completePublicationExecution: vi.fn(),
      failPublicationExecution: vi.fn(),
    };
    const publisher = { publish: vi.fn() };
    const executor = createKnowledgePublicationExecutor({
      repository,
      publisher,
      runtimeSnapshot: () => ({
        globalEnabled: true,
        disabledGroupIds: [],
        capabilities: { writeKnowledgeBase: false },
      }),
      workerId: "publication-worker-1",
      now: () => at,
    });

    await expect(executor.processBatch({ limit: 10 })).resolves.toEqual([]);
    expect(repository.listProposals).not.toHaveBeenCalled();
    expect(repository.claimApprovedPublicationExecution).not.toHaveBeenCalled();
    expect(publisher.publish).not.toHaveBeenCalled();
  });
});

function actionProposal(): ActionProposal {
  return {
    id: "proposal-1",
    actionType: "publish_knowledge_draft",
    subjectType: "knowledge_draft",
    subjectId: "draft-1",
    subjectRevision: 1,
    subjectVersion: 3,
    targetPolicyId: "policy-1",
    targetPolicyVersion: 2,
    riskLevel: "low",
    status: "approved",
    operationKey: "proposal-op",
    version: 2,
    createdAt: at,
    updatedAt: at,
  };
}

function publicationClaim(input: { proposal: ActionProposal }): ClaimApprovedPublicationExecutionResult {
  return {
    outcome: "applied",
    proposal: { ...input.proposal, status: "executing", version: 3 },
    execution: {
      id: "execution-1",
      proposalId: input.proposal.id,
      attemptNumber: 1,
      state: "executing",
      requestFingerprint: "a".repeat(64),
      provider: "feishu_wiki",
      version: 1,
      createdAt: at,
      updatedAt: at,
    },
    draft: {
      id: "draft-1",
      sourceGroupId: "oc_group",
      revisionNumber: 1,
      version: 3,
      title: "Iris pilot note",
      content: "Pilot scope and acceptance facts.",
      riskLevel: "low",
      suggestedPublication: { spaceId: "space-1" },
    },
    policy: {
      id: "policy-1",
      spaceId: "space-1",
      displayName: "Pilot wiki",
      allowedGroupIds: ["oc_group"],
      allowedRiskLevels: ["low"],
      enabled: true,
      version: 2,
      createdAt: at,
      updatedAt: at,
    },
  };
}
