import { describe, expect, it, vi } from "vitest";

import {
  createActionProposalPlanner,
  type ActionProposalDraftCandidate,
} from "../src/action-approvals/action-proposal-planner.js";
import type {
  ActionProposalRepository,
  PublicationTargetPolicy,
} from "../src/action-approvals/action-proposal-repository.js";

const at = new Date("2026-07-20T14:00:00.000Z");

describe("ActionProposalPlanner", () => {
  it("plans a bounded deterministic batch with exact operation keys", async () => {
    const candidates = [
      candidate("draft-later", { updatedAt: new Date("2026-07-20T13:00:00.000Z") }),
      candidate("draft-b", { updatedAt: new Date("2026-07-20T12:00:00.000Z") }),
      candidate("draft-a", { updatedAt: new Date("2026-07-20T12:00:00.000Z") }),
    ];
    const repository = repositoryHarness({ candidates, policies: [policy()] });
    repository.createProposal
      .mockResolvedValueOnce({ outcome: "applied", proposal: proposal("draft-a") })
      .mockResolvedValueOnce({ outcome: "already_applied", proposal: proposal("draft-b") })
      .mockResolvedValueOnce({ outcome: "applied", proposal: proposal("draft-later") });
    const planner = createActionProposalPlanner({
      repository,
      getAllowedGroupIds: () => ["oc_pilot"],
    });

    await expect(planner.planBatch({ limit: 3, at })).resolves.toEqual({
      candidateCount: 3,
      plannedCount: 2,
      alreadyPlannedCount: 1,
      ineligibleCount: 0,
      failedCount: 0,
      cancelledStaleCount: 0,
    });
    expect(repository.listEligibleDrafts).toHaveBeenCalledWith({
      groupIds: ["oc_pilot"],
      limit: 3,
    });
    expect(repository.createProposal.mock.calls.map(([input]) => ({
      draftId: input.draftId,
      operationKey: input.operationKey,
    }))).toEqual([
      { draftId: "draft-a", operationKey: "publish-knowledge:draft-a:1:3" },
      { draftId: "draft-b", operationKey: "publish-knowledge:draft-b:1:3" },
      { draftId: "draft-later", operationKey: "publish-knowledge:draft-later:1:3" },
    ]);
  });

  it("fails closed for every ambiguous or stale planning input without leaking details", async () => {
    const candidates = [
      candidate("invalid-evidence", { evidenceState: { status: "invalidated", reason: "source_missing" } }),
      candidate("missing-confirmation", { hasCurrentGroupConfirmation: false }),
      candidate("unsupported-risk", { riskLevel: "high" }),
      candidate("wrong-parent", {
        suggestedPublication: { spaceId: "space-main", parentNodeToken: "other-parent" },
      }),
      candidate("missing-target", { suggestedPublication: undefined }),
      candidate("multiple-match", { sourceGroupId: "oc_multi" }),
      candidate("create-ineligible"),
      candidate("create-failed"),
    ];
    const exact = policy();
    const repository = repositoryHarness({
      candidates,
      policies: [
        exact,
        { ...exact, id: "policy-duplicate", version: 4, allowedGroupIds: ["oc_multi"] },
        { ...exact, id: "policy-disabled", enabled: false },
      ],
    });
    repository.createProposal.mockImplementation(async (input) => {
      if (input.draftId === "create-ineligible") {
        throw Object.assign(new Error("private draft body"), { name: "ActionProposalIneligibleError" });
      }
      throw new Error("bearer secret and full draft content");
    });
    const planner = createActionProposalPlanner({
      repository,
      getAllowedGroupIds: () => ["oc_pilot"],
    });

    const result = await planner.planBatch({ limit: 8, at });

    expect(result).toEqual({
      candidateCount: 8,
      plannedCount: 0,
      alreadyPlannedCount: 0,
      ineligibleCount: 7,
      failedCount: 1,
      cancelledStaleCount: 0,
    });
    expect(JSON.stringify(result)).not.toMatch(/private draft|bearer|content/iu);
  });

  it("counts stale cancellations, uses the resulting draft version, and isolates one failure", async () => {
    const repository = repositoryHarness({
      candidates: [candidate("cancelled"), candidate("cancel-failed")],
      policies: [policy()],
    });
    repository.cancelStaleProposals.mockImplementation(async (input) => {
      if (input.draftId === "cancel-failed") throw new Error("database unavailable");
      return {
        outcome: "applied",
        cancelledProposalIds: ["old-1", "old-2"],
        draftVersion: 5,
      };
    });
    repository.createProposal.mockResolvedValue({
      outcome: "applied",
      proposal: proposal("cancelled"),
    });
    const planner = createActionProposalPlanner({
      repository,
      getAllowedGroupIds: () => ["oc_pilot"],
    });

    await expect(planner.planBatch({ limit: 2, at })).resolves.toEqual({
      candidateCount: 2,
      plannedCount: 1,
      alreadyPlannedCount: 0,
      ineligibleCount: 0,
      failedCount: 1,
      cancelledStaleCount: 2,
    });
    expect(repository.createProposal).toHaveBeenCalledWith(expect.objectContaining({
      draftId: "cancelled",
      expectedDraftVersion: 5,
    }));
  });
});

function candidate(
  id: string,
  overrides: Partial<ActionProposalDraftCandidate> = {},
): ActionProposalDraftCandidate {
  return {
    id,
    sourceGroupId: "oc_pilot",
    currentRevision: 1,
    version: 2,
    riskLevel: "medium",
    reviewer: { type: "feishu_user", ref: "ou_owner" },
    suggestedPublication: { spaceId: "space-main", parentNodeToken: "parent-main" },
    evidenceState: { status: "current" },
    hasCurrentGroupConfirmation: true,
    updatedAt: new Date("2026-07-20T12:00:00.000Z"),
    ...overrides,
  };
}

function policy(): PublicationTargetPolicy {
  return {
    id: "policy-main",
    spaceId: "space-main",
    parentNodeToken: "parent-main",
    displayName: "Main wiki",
    allowedGroupIds: ["oc_multi", "oc_pilot"],
    allowedRiskLevels: ["low", "medium"],
    enabled: true,
    version: 3,
    createdAt: at,
    updatedAt: at,
  };
}

function proposal(subjectId: string) {
  return {
    id: `proposal-${subjectId}`,
    actionType: "publish_knowledge_draft" as const,
    subjectType: "knowledge_draft" as const,
    subjectId,
    subjectRevision: 1,
    subjectVersion: 2,
    targetPolicyId: "policy-main",
    targetPolicyVersion: 3,
    riskLevel: "medium" as const,
    status: "pending_approval" as const,
    operationKey: `publish-knowledge:${subjectId}:1:3`,
    version: 1,
    createdAt: at,
    updatedAt: at,
  };
}

function repositoryHarness(input: {
  candidates: ActionProposalDraftCandidate[];
  policies: PublicationTargetPolicy[];
}) {
  return {
    listEligibleDrafts: vi.fn(async () => input.candidates),
    listTargetPolicies: vi.fn(async () => input.policies),
    cancelStaleProposals: vi.fn(async (request) => ({
      outcome: "applied" as const,
      cancelledProposalIds: [],
      draftVersion: request.currentDraftVersion,
    })),
    createProposal: vi.fn(),
  } as unknown as Pick<
    ActionProposalRepository,
    "listEligibleDrafts" | "listTargetPolicies" | "cancelStaleProposals" | "createProposal"
  > & {
    listEligibleDrafts: ReturnType<typeof vi.fn>;
    listTargetPolicies: ReturnType<typeof vi.fn>;
    cancelStaleProposals: ReturnType<typeof vi.fn>;
    createProposal: ReturnType<typeof vi.fn>;
  };
}
