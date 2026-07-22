import { describe, expect, it, vi } from "vitest";

import {
  createActionApprovalWorker,
} from "../src/action-approvals/action-approval-worker.js";
import type {
  ActionApprovalDeliveryContext,
} from "../src/action-approvals/action-proposal-repository.js";
import {
  ActionProposalAuthorizationError,
  ActionProposalIneligibleError,
  ActionProposalOperationConflictError,
  ActionProposalVersionConflictError,
} from "../src/action-approvals/postgres-action-proposal-repository.js";
import type {
  ActionProposalApprovalInteractionJob,
} from "../src/knowledge-cards/knowledge-card.js";

const at = new Date("2026-07-20T03:00:00.000Z");

describe("ActionApprovalWorker", () => {
  it("rechecks live facts in order and commits an exact owner approval", async () => {
    const order: string[] = [];
    const harness = createHarness({
      runtimeEnabled: () => { order.push("runtime"); return true; },
      getContext: async () => { order.push("context"); return context(); },
      preflight: async () => { order.push("preflight"); return { sourceGroupId: "oc_source" }; },
      membership: async () => { order.push("membership"); return true; },
      groupEnabled: () => { order.push("group"); return true; },
      apply: async () => { order.push("apply"); return mutation("applied"); },
      update: async () => { order.push("update"); },
    });

    await expect(harness.worker.processActionApproval(job())).resolves.toEqual({
      status: "applied",
      code: "action_approval_applied",
    });
    expect(order).toEqual([
      "runtime", "context", "preflight", "group", "membership",
      "runtime", "group", "apply", "update",
    ]);
    expect(harness.repository.applyApprovalAction).toHaveBeenCalledWith({
      proposalId: "proposal-1",
      requirementId: "requirement-1",
      expectedProposalVersion: 4,
      expectedSubjectRevision: 2,
      expectedSubjectVersion: 7,
      expectedTargetPolicyVersion: 3,
      sourcePresentationId: "proposal-presentation-1",
      callbackEventId: "event-1",
      actorOpenId: "ou_owner",
      action: "approve",
      operationKey: "action-approval:cli_app:event-1",
      at: job().receivedAt,
    });
  });

  it.each([
    ["runtime disabled", { runtimeEnabled: () => false }, "runtime_disabled"],
    ["bot actor", { actorOpenId: "ou_bot" }, "bot_actor"],
    ["not current member", { membership: async () => false }, "not_current_member"],
    ["stale presentation", { getContext: async () => context({ proposalVersion: 5 }) }, "stale_presentation"],
    ["revoked authorization", { preflight: async () => { throw new ActionProposalAuthorizationError(); } }, "not_authorized"],
    ["invalid evidence", { preflight: async () => { throw new ActionProposalIneligibleError(); } }, "evidence_or_policy_invalid"],
  ] as const)("denies %s without mutation", async (_label, overrides, code) => {
    const typedOverrides = overrides as Overrides;
    const harness = createHarness(typedOverrides);
    await expect(harness.worker.processActionApproval(job({
      ...(typedOverrides.actorOpenId === undefined ? {} : { actorOpenId: typedOverrides.actorOpenId }),
    }))).resolves.toEqual({ status: "denied", code });
    expect(harness.repository.applyApprovalAction).not.toHaveBeenCalled();
  });

  it("skips group membership only for a company-level proposal", async () => {
    const harness = createHarness({ preflight: async () => ({}) });
    await expect(harness.worker.processActionApproval(job())).resolves.toMatchObject({ status: "applied" });
    expect(harness.membershipChecker.isCurrentMember).not.toHaveBeenCalled();
  });

  it("rechecks both runtime gates after live membership", async () => {
    let runtimeReads = 0;
    const harness = createHarness({ runtimeEnabled: () => ++runtimeReads === 1 });
    await expect(harness.worker.processActionApproval(job())).resolves.toEqual({
      status: "denied",
      code: "runtime_disabled",
    });
    expect(harness.repository.applyApprovalAction).not.toHaveBeenCalled();
  });

  it.each([
    ["membership", { membership: async () => { throw new Error("private"); } }, "membership_unavailable"],
    ["context", { getContext: async () => { throw new Error("private"); } }, "repository_unavailable"],
    ["mutation", { apply: async () => { throw new Error("private"); } }, "repository_unavailable"],
  ] as const)("classifies transient %s failure", async (_label, overrides, code) => {
    await expect(createHarness(overrides).worker.processActionApproval(job())).resolves.toEqual({
      status: "retryable",
      code,
    });
  });

  it("maps an atomic version race to a stable denial", async () => {
    const harness = createHarness({
      apply: async () => { throw new ActionProposalVersionConflictError(); },
    });
    await expect(harness.worker.processActionApproval(job())).resolves.toEqual({
      status: "denied",
      code: "stale_presentation",
    });
  });

  it.each([
    ["request_revision", { reason: "Clarify ownership." }],
    ["reject", { reason: "Conflicts with policy.", rejectionConfirmed: true }],
  ] as const)("passes a normalized %s decision to the atomic repository", async (action, extra) => {
    const harness = createHarness({ apply: async () => mutation("applied", action) });
    await harness.worker.processActionApproval(job({ action }), { id: "intent-1", ...extra });
    expect(harness.repository.applyApprovalAction).toHaveBeenCalledWith(expect.objectContaining({
      action,
      ...extra,
    }));
  });

  it("does not retry a committed action when card updates fail", async () => {
    const harness = createHarness({ update: async () => { throw new Error("remote unavailable"); } });
    await expect(harness.worker.processActionApproval(job())).resolves.toEqual({
      status: "applied",
      code: "action_approval_applied",
    });
    expect(harness.repository.applyApprovalAction).toHaveBeenCalledOnce();
  });

  it("returns an idempotent replay without exposing callback or proposal content", async () => {
    const result = await createHarness({ apply: async () => mutation("already_applied") })
      .worker.processActionApproval(job());
    expect(result).toEqual({ status: "already_applied", code: "duplicate_callback" });
    expect(JSON.stringify(result)).not.toMatch(/ou_owner|draft body|secret evidence|event-1/iu);
  });

  it("re-authorizes an exact sequential replay after its presentation closes", async () => {
    const replay = mutation("already_applied");
    const harness = createHarness({
      getContext: async () => {
        const value = context();
        return {
          ...value,
          context: {
            ...value.context,
            proposal: { ...value.context.proposal, status: "approved", version: 6 },
          },
          presentation: { ...value.presentation, state: "closed", closedAt: at },
        };
      },
      inspectReplay: async () => ({ result: replay, sourceGroupId: "oc_source" }),
    });

    await expect(harness.worker.processActionApproval(job())).resolves.toEqual({
      status: "already_applied",
      code: "duplicate_callback",
    });
    expect(harness.repository.inspectApprovalActionReplay).toHaveBeenCalledOnce();
    expect(harness.membershipChecker.isCurrentMember).toHaveBeenCalledWith({
      chatId: "oc_source",
      openId: "ou_owner",
    });
    expect(harness.repository.applyApprovalAction).not.toHaveBeenCalled();
  });

  it("denies a conflicting sequential callback replay after the presentation closes", async () => {
    const harness = createHarness({
      inspectReplay: async () => { throw new ActionProposalOperationConflictError(); },
    });

    await expect(harness.worker.processActionApproval(job())).resolves.toEqual({
      status: "denied",
      code: "immutable_intent_conflict",
    });
    expect(harness.repository.applyApprovalAction).not.toHaveBeenCalled();
  });

  it("includes the target policy version in immutable replay inspection", async () => {
    const inspectReplay = vi.fn(async () => ({
      result: mutation("already_applied"),
      sourceGroupId: "oc_source",
    }));
    const harness = createHarness({ inspectReplay });

    await harness.worker.processActionApproval(job({ targetPolicyVersion: 9 }));

    expect(inspectReplay).toHaveBeenCalledWith(expect.objectContaining({
      expectedTargetPolicyVersion: 9,
    }));
  });

  it("refreshes every proposal card through bounded cursor pages", async () => {
    const presentations = Array.from({ length: 101 }, (_, index) => ({
      ...context().presentation,
      id: `proposal-presentation-${String(index + 1).padStart(3, "0")}`,
      messageId: `om_approval_${index + 1}`,
    }));
    const listPresentations = vi.fn(async (input: { afterId?: string; limit: number }) => {
      const start = input.afterId === undefined
        ? 0
        : presentations.findIndex((item) => item.id === input.afterId) + 1;
      return presentations.slice(start, start + input.limit);
    });
    const harness = createHarness({ listPresentations });

    await expect(harness.worker.processActionApproval(job())).resolves.toMatchObject({
      status: "applied",
    });
    expect(harness.cardClient.updateCard).toHaveBeenCalledTimes(101);
    expect(listPresentations).toHaveBeenNthCalledWith(1, {
      proposalId: "proposal-1",
      limit: 100,
    });
    expect(listPresentations).toHaveBeenNthCalledWith(2, {
      proposalId: "proposal-1",
      afterId: "proposal-presentation-100",
      limit: 100,
    });
  });
});

type Overrides = {
  actorOpenId?: string;
  runtimeEnabled?: () => boolean;
  groupEnabled?: () => boolean;
  getContext?: () => Promise<ActionApprovalDeliveryContext | undefined>;
  preflight?: () => Promise<{ sourceGroupId?: string }>;
  inspectReplay?: () => Promise<{
    result: ReturnType<typeof mutation>;
    sourceGroupId?: string;
  } | undefined>;
  membership?: () => Promise<boolean>;
  apply?: () => Promise<ReturnType<typeof mutation>>;
  listPresentations?: (input: { proposalId: string; afterId?: string; limit: number }) => Promise<
    ActionApprovalDeliveryContext["presentation"][]
  >;
  update?: () => Promise<void>;
};

function createHarness(overrides: Overrides = {}) {
  const repository = {
    getApprovalDeliveryContext: vi.fn(overrides.getContext ?? (async () => context())),
    preflightApprovalAction: vi.fn(overrides.preflight ?? (async () => ({ sourceGroupId: "oc_source" }))),
    inspectApprovalActionReplay: vi.fn(overrides.inspectReplay ?? (async () => undefined)),
    applyApprovalAction: vi.fn(overrides.apply ?? (async () => mutation("applied"))),
    listApprovalPresentations: vi.fn(overrides.listPresentations ?? (async () => [context().presentation])),
  };
  const membershipChecker = {
    isCurrentMember: vi.fn(overrides.membership ?? (async () => true)),
  };
  const cardClient = { updateCard: vi.fn(overrides.update ?? (async () => undefined)) };
  return {
    repository,
    membershipChecker,
    cardClient,
    worker: createActionApprovalWorker({
      repository,
      membershipChecker,
      cardClient,
      isActionApprovalRuntimeEnabled: overrides.runtimeEnabled ?? (() => true),
      canUseActionApprovalsForSourceGroup: overrides.groupEnabled ?? (() => true),
      botOpenId: "ou_bot",
      now: () => new Date(at),
    }),
  };
}

function job(overrides: Partial<ActionProposalApprovalInteractionJob> = {}): ActionProposalApprovalInteractionJob {
  return {
    kind: "action_proposal_approval",
    idempotencyKey: "feishu-card:cli_app:event-1",
    eventId: "event-1",
    appId: "cli_app",
    actorOpenId: "ou_owner",
    chatId: "oc_dm",
    messageId: "om_approval",
    presentationId: "proposal-presentation-1",
    proposalId: "proposal-1",
    requirementId: "requirement-1",
    proposalVersion: 4,
    subjectRevision: 2,
    subjectVersion: 7,
    targetPolicyVersion: 3,
    action: "approve",
    receivedAt: new Date("2026-07-20T02:59:00.000Z"),
    attempts: 0,
    ...overrides,
  };
}

function context(overrides: { proposalVersion?: number } = {}): ActionApprovalDeliveryContext {
  const createdAt = new Date("2026-07-20T00:00:00.000Z");
  const requirement = {
    id: "requirement-1",
    proposalId: "proposal-1",
    kind: "designated_owner" as const,
    roleRefType: "feishu_user" as const,
    roleRef: "ou_owner",
    targetPolicyId: "policy-1",
    targetPolicyVersion: 3,
    state: "pending" as const,
    version: 1,
    createdAt,
    updatedAt: createdAt,
  };
  return {
    context: {
      proposal: {
        id: "proposal-1",
        actionType: "publish_knowledge_draft",
        subjectType: "knowledge_draft",
        subjectId: "draft-1",
        subjectRevision: 2,
        subjectVersion: 7,
        targetPolicyId: "policy-1",
        targetPolicyVersion: 3,
        riskLevel: "medium",
        status: "pending_approval",
        operationKey: "proposal-operation",
        version: overrides.proposalVersion ?? 4,
        createdAt,
        updatedAt: createdAt,
      },
      requirements: [requirement],
      approvals: [],
    },
    requirement,
    policy: {
      id: "policy-1",
      spaceId: "space-1",
      displayName: "Company Wiki",
      allowedGroupIds: ["oc_source"],
      allowedRiskLevels: ["medium"],
      enabled: true,
      version: 3,
      createdAt,
      updatedAt: createdAt,
    },
    presentation: {
      id: "proposal-presentation-1",
      proposalId: "proposal-1",
      requirementId: "requirement-1",
      proposalVersion: 4,
      recipientOpenId: "ou_owner",
      state: "active",
      messageId: "om_approval",
      operationKey: "presentation-operation",
      version: 2,
      createdAt,
      activatedAt: createdAt,
    },
  };
}

function mutation(outcome: "applied" | "already_applied", action: "approve" | "request_revision" | "reject" = "approve") {
  return {
    outcome,
    action,
    proposal: { ...context().context.proposal, status: action === "approve" ? "approved" as const : "cancelled" as const, version: 5 },
    draftStatus: action === "approve" ? "pending_review" as const : action === "request_revision" ? "needs_revision" as const : "rejected" as const,
    draftVersion: 8,
  };
}
