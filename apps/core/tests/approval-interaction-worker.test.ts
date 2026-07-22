import { describe, expect, it, vi } from "vitest";

import { createApprovalInteractionWorker } from "../src/knowledge-cards/approval-interaction-worker.js";
import type { ApprovalInteractionJob } from "../src/knowledge-cards/knowledge-card.js";
import type {
  KnowledgeCardCommittedResult,
  KnowledgeCardPresentationContext,
  KnowledgeDraftPresentation,
} from "../src/knowledge-cards/knowledge-card-repository.js";
import {
  KnowledgeCardMembershipProofError,
  KnowledgeCardOperationConflictError,
  KnowledgeCardPersistenceConflictError,
} from "../src/knowledge-cards/postgres-knowledge-card-repository.js";
import { KnowledgeDraftEvidenceError } from "../src/knowledge-governance/postgres-knowledge-draft-evidence.js";

const at = new Date("2026-07-19T02:00:00.000Z");

describe("ApprovalInteractionWorker", () => {
  it("processes an authorized action in the required order and acknowledges it", async () => {
    const order: string[] = [];
    const harness = createHarness({
      canUseKnowledgeCards: (groupId) => {
        order.push(`gate:${groupId}`);
        return true;
      },
      getPresentation: async () => {
        order.push("presentation");
        return presentation();
      },
      isCurrentMember: async () => {
        order.push("membership");
        return true;
      },
      applyInteraction: async (input) => {
        order.push("apply");
        expect(input.membershipCheckedAt).toEqual(at);
        expect(input.at.getTime() - input.membershipCheckedAt.getTime()).toBeLessThanOrEqual(30_000);
        return mutationResult("applied");
      },
      updateCard: async () => {
        order.push("update");
      },
      acknowledge: async () => {
        order.push("ack");
      },
    });

    await expect(harness.worker.processBatch({ limit: 10 })).resolves.toEqual([
      {
        status: "applied",
        idempotencyKey: job().idempotencyKey,
        code: "action_applied",
      },
    ]);
    expect(order).toEqual([
      `gate:${job().chatId}`,
      "presentation",
      "membership",
      `gate:${job().chatId}`,
      "apply",
      "update",
      "ack",
    ]);
  });

  it.each([
    ["runtime_disabled", { canUseKnowledgeCards: () => false }],
    ["bot_actor", { actorOpenId: "ou_bot" }],
    ["not_current_member", { isCurrentMember: async () => false }],
    ["stale_presentation", { presentation: undefined }],
    ["stale_presentation", { presentation: presentation({ draftVersion: 2 }) }],
  ] as const)("acknowledges stable denial %s without applying", async (code, overrides) => {
    const harness = createHarness(overrides);

    await expect(harness.worker.processBatch({ limit: 1 })).resolves.toEqual([
      { status: "denied", idempotencyKey: job().idempotencyKey, code },
    ]);
    expect(harness.repository.applyInteraction).not.toHaveBeenCalled();
    expect(harness.queue.acknowledge).toHaveBeenCalledOnce();
    expect(harness.queue.handleFailure).not.toHaveBeenCalled();
    expect(harness.cardClient.updateCard).toHaveBeenCalledOnce();
  });

  it("re-authorizes an exact closed presentation before repository replay", async () => {
    const canUseKnowledgeCards = vi.fn(() => true);
    const isCurrentMember = vi.fn(async () => true);
    const harness = createHarness({
      presentation: presentation({ state: "closed", closedAt: at, version: 3 }),
      canUseKnowledgeCards,
      isCurrentMember,
      applyInteraction: async () => mutationResult("already_applied"),
    });

    await expect(harness.worker.processBatch({ limit: 1 })).resolves.toEqual([{
      status: "already_applied",
      idempotencyKey: job().idempotencyKey,
      code: "duplicate_callback",
    }]);
    expect(canUseKnowledgeCards).toHaveBeenCalledTimes(2);
    expect(isCurrentMember).toHaveBeenCalledOnce();
    expect(harness.repository.applyInteraction).toHaveBeenCalledOnce();
    const cardJson = harness.cardClient.updateCard.mock.calls[0]?.[0]?.cardJson as string;
    expect(cardJson).toContain("Iris / confirmed");
    expect(cardJson).not.toContain("This action was already processed.");
  });

  it.each([
    ["runtime disable", { canUseKnowledgeCards: () => false }, "runtime_disabled"],
    ["bot actor", { actorOpenId: "ou_bot" }, "bot_actor"],
    ["membership denial", { isCurrentMember: async () => false }, "not_current_member"],
    [
      "immutable intent conflict",
      { applyInteraction: async () => { throw new KnowledgeCardOperationConflictError(); } },
      "immutable_intent_conflict",
    ],
  ] as const)("keeps the committed result card on closed %s", async (_label, overrides, code) => {
    const context = committedContext();
    const harness = createHarness({
      presentation: context.presentation,
      getPresentationContext: async () => context,
      ...overrides,
    });

    await expect(harness.worker.processBatch({ limit: 1 })).resolves.toEqual([{
      status: "denied",
      idempotencyKey: job().idempotencyKey,
      code,
    }]);
    expect(harness.cardClient.updateCard).toHaveBeenCalledOnce();
    const cardJson = harness.cardClient.updateCard.mock.calls[0]?.[0]?.cardJson as string;
    expect(cardJson).toContain("Iris / revision_requested");
    expect(cardJson).toContain("Reason: Committed closed reason.");
    expect(cardJson).not.toMatch(
      /currently disabled|approve its own|current group members|already processed|action conflicts/iu,
    );
  });

  it("restores the committed result card on a closed membership error", async () => {
    const context = committedContext();
    const harness = createHarness({
      presentation: context.presentation,
      getPresentationContext: async () => context,
      isCurrentMember: async () => { throw new Error("membership unavailable"); },
    });

    await expect(harness.worker.processBatch({ limit: 1 })).resolves.toEqual([{
      status: "retrying",
      idempotencyKey: job().idempotencyKey,
      code: "membership_unavailable",
    }]);
    expect(harness.cardClient.updateCard).toHaveBeenCalledOnce();
    expect(harness.cardClient.updateCard.mock.calls[0]?.[0]?.cardJson).toContain(
      "Iris / revision_requested",
    );
    expect(harness.queue.handleFailure).toHaveBeenCalledOnce();
  });

  it("fails closed when the live gate is disabled while membership is pending", async () => {
    let enabled = true;
    let membershipStarted!: () => void;
    let resolveMembership!: (isCurrentMember: boolean) => void;
    const started = new Promise<void>((resolve) => {
      membershipStarted = resolve;
    });
    const membership = new Promise<boolean>((resolve) => {
      resolveMembership = resolve;
    });
    const harness = createHarness({
      canUseKnowledgeCards: () => enabled,
      isCurrentMember: async () => {
        membershipStarted();
        return membership;
      },
    });

    const processing = harness.worker.processBatch({ limit: 1 });
    await started;
    enabled = false;
    resolveMembership(true);

    await expect(processing).resolves.toEqual([{
      status: "denied",
      idempotencyKey: job().idempotencyKey,
      code: "runtime_disabled",
    }]);
    expect(harness.repository.applyInteraction).not.toHaveBeenCalled();
    expect(harness.queue.acknowledge).toHaveBeenCalledOnce();
    expect(harness.queue.handleFailure).not.toHaveBeenCalled();
  });

  it.each([
    [new KnowledgeCardPersistenceConflictError(), "stale_presentation"],
    [new KnowledgeCardMembershipProofError(), "invalid_membership_evidence"],
    [new KnowledgeDraftEvidenceError("message_deleted"), "evidence_invalidated"],
    [new KnowledgeCardOperationConflictError(), "immutable_intent_conflict"],
  ] as const)("acks stable repository denial %s", async (error, code) => {
    const harness = createHarness({
      applyInteraction: async () => {
        throw error;
      },
    });

    await expect(harness.worker.processBatch({ limit: 1 })).resolves.toEqual([
      { status: "denied", idempotencyKey: job().idempotencyKey, code },
    ]);
    expect(harness.queue.acknowledge).toHaveBeenCalledOnce();
    expect(harness.queue.handleFailure).not.toHaveBeenCalled();
  });

  it("passes normalized revision and rejection decisions to the atomic repository action", async () => {
    const revision = createHarness({
      job: job({ action: "request_revision", intentId: "intent-revision" }),
      resolveIntent: async () => ({ id: "intent-revision", reason: "Clarify ownership." }),
    });
    const rejection = createHarness({
      job: job({ action: "reject", intentId: "intent-rejection" }),
      resolveIntent: async () => ({
        id: "intent-rejection",
        reason: "Conflicts with policy.",
        rejectionConfirmed: true,
      }),
    });

    await revision.worker.processBatch({ limit: 1 });
    await rejection.worker.processBatch({ limit: 1 });

    expect(revision.repository.applyInteraction).toHaveBeenCalledWith(expect.objectContaining({
      action: "request_revision",
      reason: "Clarify ownership.",
    }));
    expect(rejection.repository.applyInteraction).toHaveBeenCalledWith(expect.objectContaining({
      action: "reject",
      reason: "Conflicts with policy.",
      rejectionConfirmed: true,
    }));
  });

  it("resolves a sensitive intent in memory and deletes it only after the queue ack", async () => {
    const order: string[] = [];
    const sensitiveJob = job({
      action: "request_revision",
      intentId: "f31bed07-5772-4a26-bdf0-a472f0b5bc7b",
    });
    const harness = createHarness({
      job: sensitiveJob,
      resolveIntent: async () => {
        order.push("resolve");
        return {
          id: sensitiveJob.intentId!,
          reason: "Preserved  normalized reason.",
        };
      },
      applyInteraction: async (input) => {
        order.push("apply");
        expect(input).toMatchObject({
          action: "request_revision",
          reason: "Preserved  normalized reason.",
        });
        return mutationResult("applied", {
          action: "request_revision",
          state: "needs_revision",
          reason: "Preserved  normalized reason.",
        });
      },
      acknowledge: async () => {
        order.push("ack");
      },
      deleteIntent: async () => {
        order.push("delete");
      },
    });

    await expect(harness.worker.processBatch({ limit: 1 })).resolves.toMatchObject([{
      status: "applied",
      code: "action_applied",
    }]);
    expect(order).toEqual(["resolve", "apply", "ack", "delete"]);
    expect(harness.queue.handleFailure).not.toHaveBeenCalled();
  });

  it("retains a sensitive intent across transient failure", async () => {
    const sensitiveJob = job({
      action: "reject",
      intentId: "e7d06a67-5ea4-4da0-a9ac-911cceae0b1e",
    });
    const harness = createHarness({
      job: sensitiveJob,
      resolveIntent: async () => { throw new Error("postgres unavailable"); },
    });

    await expect(harness.worker.processBatch({ limit: 1 })).resolves.toEqual([{
      status: "retrying",
      idempotencyKey: sensitiveJob.idempotencyKey,
      code: "repository_unavailable",
    }]);
    expect(harness.repository.applyInteraction).not.toHaveBeenCalled();
    expect(harness.intentStore.deleteIntent).not.toHaveBeenCalled();
    expect(harness.queue.handleFailure).toHaveBeenCalledOnce();
  });

  it("restores a committed card without deleting an immutable conflicting intent", async () => {
    const sensitiveJob = job({
      action: "request_revision",
      intentId: "intent-conflicting-redelivery",
    });
    const harness = createHarness({
      job: sensitiveJob,
      getPresentationContext: async () => committedContext(),
    });

    await expect(harness.worker.processBatch({ limit: 1 })).resolves.toEqual([{
      status: "denied",
      idempotencyKey: sensitiveJob.idempotencyKey,
      code: "immutable_intent_conflict",
    }]);
    expect(harness.cardClient.updateCard).toHaveBeenCalledOnce();
    expect(harness.cardClient.updateCard.mock.calls[0]?.[0]?.cardJson).toContain(
      "Iris / revision_requested",
    );
    expect(harness.queue.acknowledge).toHaveBeenCalledOnce();
    expect(harness.intentStore.deleteIntent).not.toHaveBeenCalled();
  });

  it("does not retry a committed mutation when post-ack intent cleanup fails", async () => {
    const sensitiveJob = job({
      action: "reject",
      intentId: "85777560-95e0-4566-b2c5-e86f9c12d12a",
    });
    const harness = createHarness({
      job: sensitiveJob,
      resolveIntent: async () => ({
        id: sensitiveJob.intentId!,
        reason: "Durable rejection reason.",
        rejectionConfirmed: true,
      }),
      deleteIntent: async () => { throw new Error("cleanup unavailable"); },
      applyInteraction: async () => mutationResult("applied", {
        action: "reject",
        state: "rejected",
        reason: "Durable rejection reason.",
      }),
    });

    await expect(harness.worker.processBatch({ limit: 1 })).resolves.toMatchObject([{
      status: "applied",
      code: "action_applied",
    }]);
    expect(harness.queue.acknowledge).toHaveBeenCalledOnce();
    expect(harness.intentStore.deleteIntent).toHaveBeenCalledOnce();
    expect(harness.queue.handleFailure).not.toHaveBeenCalled();
    expect(harness.repository.applyInteraction).toHaveBeenCalledOnce();
  });

  it.each([
    [
      "confirm",
      { action: "confirm" },
      undefined,
      {
        action: "confirm",
        actorOpenId: "ou_committed_actor",
        confirmedAt: at,
        nextGate: "pending_review",
      },
      ["Iris / confirmed", "Confirmed by: ou_committed_actor", "Next gate: pending_review"],
    ],
    [
      "request revision",
      { action: "request_revision", intentId: "intent-committed-revision" },
      { id: "intent-committed-revision", reason: "UNTRUSTED callback revision reason" },
      {
        action: "request_revision",
        state: "needs_revision",
        reason: "Committed revision reason.",
      },
      ["Iris / revision_requested", "State: needs_revision", "Reason: Committed revision reason."],
    ],
    [
      "reject",
      {
        action: "reject",
        intentId: "intent-committed-rejection",
      },
      {
        id: "intent-committed-rejection",
        reason: "UNTRUSTED callback rejection reason",
        rejectionConfirmed: true,
      },
      {
        action: "reject",
        state: "rejected",
        reason: "Committed rejection reason.",
      },
      ["Iris / rejected", "State: rejected", "Reason: Committed rejection reason."],
    ],
  ] as const)("immediately renders the committed %s result instead of callback text", async (
    _label,
    jobOverrides,
    resolvedIntent,
    committedResult,
    expectedText,
  ) => {
    const harness = createHarness({
      job: job(jobOverrides as Partial<ApprovalInteractionJob>),
      ...(resolvedIntent === undefined ? {} : { resolveIntent: async () => resolvedIntent }),
      applyInteraction: async () => mutationResult("applied", committedResult),
    });

    await expect(harness.worker.processBatch({ limit: 1 })).resolves.toMatchObject([
      { status: "applied", code: "action_applied" },
    ]);

    const cardJson = harness.cardClient.updateCard.mock.calls[0]?.[0]?.cardJson as string;
    for (const text of expectedText) expect(cardJson).toContain(text);
    expect(cardJson).toContain("Source type: group_conclusion");
    expect(cardJson).toContain("Draft ID: draft-1");
    expect(cardJson).toContain("Draft revision: 1");
    expect(cardJson).toContain("Draft version: 1");
    expect(cardJson).not.toMatch(/UNTRUSTED callback|draft body|evidence/iu);
  });

  it("acknowledges an exact idempotent replay without exposing or reapplying content", async () => {
    const harness = createHarness({
      applyInteraction: async () => mutationResult("already_applied"),
    });

    const results = await harness.worker.processBatch({ limit: 1 });

    expect(results).toEqual([{
      status: "already_applied",
      idempotencyKey: job().idempotencyKey,
      code: "duplicate_callback",
    }]);
    expect(harness.repository.applyInteraction).toHaveBeenCalledOnce();
    expect(harness.queue.acknowledge).toHaveBeenCalledOnce();
    expect(JSON.stringify(results)).not.toMatch(/draft body|evidence|raw reason|ou_actor|token/iu);
  });

  it("does not retry a committed transition when its immediate card update fails", async () => {
    const harness = createHarness({
      updateCard: async () => {
        throw new Error("remote update unavailable");
      },
    });

    await expect(harness.worker.processBatch({ limit: 1 })).resolves.toMatchObject([
      { status: "applied", code: "action_applied" },
    ]);
    expect(harness.repository.applyInteraction).toHaveBeenCalledOnce();
    expect(harness.queue.handleFailure).not.toHaveBeenCalled();
    expect(harness.queue.acknowledge).toHaveBeenCalledOnce();
  });

  it("dispatches an action proposal job without touching the knowledge draft repository", async () => {
    const processActionApproval = vi.fn(async () => ({
      status: "applied" as const,
      code: "action_approval_applied" as const,
    }));
    const harness = createHarness({
      job: actionJob(),
      actionApprovalWorker: { processActionApproval },
    });

    await expect(harness.worker.processBatch({ limit: 1 })).resolves.toEqual([{
      status: "applied",
      idempotencyKey: actionJob().idempotencyKey,
      code: "action_approval_applied",
    }]);
    expect(processActionApproval).toHaveBeenCalledWith(actionJob(), undefined);
    expect(harness.repository.getPresentation).not.toHaveBeenCalled();
    expect(harness.repository.applyInteraction).not.toHaveBeenCalled();
    expect(harness.queue.acknowledge).toHaveBeenCalledOnce();
  });

  it("routes a retryable action proposal result through the shared finite queue", async () => {
    const harness = createHarness({
      job: actionJob(),
      actionApprovalWorker: {
        processActionApproval: vi.fn(async () => ({
          status: "retryable" as const,
          code: "repository_unavailable" as const,
        })),
      },
    });
    await expect(harness.worker.processBatch({ limit: 1 })).resolves.toEqual([{
      status: "retrying",
      idempotencyKey: actionJob().idempotencyKey,
      code: "repository_unavailable",
    }]);
    expect(harness.queue.handleFailure).toHaveBeenCalledOnce();
    expect(harness.queue.acknowledge).not.toHaveBeenCalled();
  });

  it.each([
    ["membership", "membership_unavailable"],
    ["presentation", "repository_unavailable"],
    ["apply", "repository_unavailable"],
  ] as const)("routes transient %s failures through the finite queue code %s", async (stage, code) => {
    const failure = new Error(`${stage} unavailable with private diagnostics`);
    const harness = createHarness({
      ...(stage === "membership" ? { isCurrentMember: async () => { throw failure; } } : {}),
      ...(stage === "presentation" ? { getPresentation: async () => { throw failure; } } : {}),
      ...(stage === "apply" ? { applyInteraction: async () => { throw failure; } } : {}),
    });

    await expect(harness.worker.processBatch({ limit: 1 })).resolves.toEqual([{
      status: "retrying",
      idempotencyKey: job().idempotencyKey,
      code,
    }]);
    expect(harness.queue.handleFailure).toHaveBeenCalledWith({
      job: expect.objectContaining({ idempotencyKey: job().idempotencyKey }),
      workerId: "approval-worker-1",
      errorCode: code,
      at,
    });
    expect(harness.queue.acknowledge).not.toHaveBeenCalled();
  });

  it("reports terminal queue handling without leaking the failure or job secrets", async () => {
    const harness = createHarness({
      isCurrentMember: async () => { throw new Error("tenant token secret"); },
      handleFailure: async () => ({ action: "dead_lettered" as const }),
    });

    const results = await harness.worker.processBatch({ limit: 1 });

    expect(results).toEqual([{
      status: "dead_lettered",
      idempotencyKey: job().idempotencyKey,
      code: "membership_unavailable",
    }]);
    expect(JSON.stringify(results)).not.toMatch(/tenant token|ou_actor|draft body|raw reason/iu);
  });

  it("bounds claims and rejects unsafe batch limits", async () => {
    const harness = createHarness({ claimedJobs: [] });

    await harness.worker.processBatch({ limit: 1000 });
    expect(harness.queue.claimBatch).toHaveBeenCalledWith({
      limit: 100,
      workerId: "approval-worker-1",
      now: at,
      leaseUntil: new Date(at.getTime() + 30_000),
    });
    await expect(harness.worker.processBatch({ limit: Number.POSITIVE_INFINITY })).rejects.toThrow(
      "approval interaction batch limit",
    );
  });
});

type HarnessOverrides = {
  job?: ApprovalInteractionJob;
  claimedJobs?: ApprovalInteractionJob[];
  actorOpenId?: string;
  presentation?: KnowledgeDraftPresentation;
  canUseKnowledgeCards?: (groupId: string) => boolean;
  getPresentation?: () => Promise<KnowledgeDraftPresentation | undefined>;
  getPresentationContext?: () => Promise<KnowledgeCardPresentationContext | undefined>;
  isCurrentMember?: () => Promise<boolean>;
  applyInteraction?: (...args: any[]) => Promise<any>;
  updateCard?: (input: { messageId: string; cardJson: string }) => Promise<void>;
  acknowledge?: () => Promise<void>;
  handleFailure?: () => Promise<{ action: "delayed" | "dead_lettered" }>;
  actionApprovalWorker?: {
    processActionApproval: (job: Extract<ApprovalInteractionJob, { kind: "action_proposal_approval" }>) => Promise<any>;
  };
  resolveIntent?: (...args: any[]) => Promise<any>;
  deleteIntent?: (...args: any[]) => Promise<void>;
};

function createHarness(overrides: HarnessOverrides = {}) {
  const claimedJob = overrides.job ?? job({
    ...(overrides.actorOpenId === undefined ? {} : { actorOpenId: overrides.actorOpenId }),
  });
  const queue = {
    claimBatch: vi.fn(async () => overrides.claimedJobs ?? [claimedJob]),
    acknowledge: vi.fn(overrides.acknowledge ?? (async () => undefined)),
    handleFailure: vi.fn(overrides.handleFailure ?? (async () => ({ action: "delayed" as const }))),
  };
  const repository = {
    getPresentation: vi.fn(overrides.getPresentation ?? (async () =>
      "presentation" in overrides ? overrides.presentation : presentation())),
    getPresentationContext: vi.fn(overrides.getPresentationContext ?? (async () => undefined)),
    applyInteraction: vi.fn(overrides.applyInteraction ?? (async () => mutationResult("applied"))),
  };
  const membershipChecker = {
    isCurrentMember: vi.fn(overrides.isCurrentMember ?? (async () => true)),
  };
  const cardClient = {
    updateCard: vi.fn(overrides.updateCard ?? (async () => undefined)),
  };
  const intentStore = {
    resolveIntent: vi.fn(overrides.resolveIntent ?? (async () => undefined)),
    deleteIntent: vi.fn(overrides.deleteIntent ?? (async () => undefined)),
  };
  return {
    queue,
    repository,
    membershipChecker,
    cardClient,
    intentStore,
    worker: createApprovalInteractionWorker({
      queue,
      repository,
      membershipChecker,
      cardClient,
      canUseKnowledgeCards: overrides.canUseKnowledgeCards ?? (() => true),
      botOpenId: "ou_bot",
      workerId: "approval-worker-1",
      leaseMs: 30_000,
      now: () => new Date(at),
      actionApprovalWorker: overrides.actionApprovalWorker,
      intentStore,
    }),
  };
}

function actionJob(): Extract<ApprovalInteractionJob, { kind: "action_proposal_approval" }> {
  return {
    kind: "action_proposal_approval",
    idempotencyKey: "card-action:proposal-event-1",
    eventId: "proposal-event-1",
    appId: "cli_app",
    actorOpenId: "ou_owner",
    chatId: "oc_dm",
    messageId: "om_proposal_card",
    presentationId: "proposal-presentation-1",
    proposalId: "proposal-1",
    requirementId: "requirement-1",
    proposalVersion: 4,
    subjectRevision: 2,
    subjectVersion: 7,
    targetPolicyVersion: 3,
    action: "approve",
    receivedAt: new Date(at.getTime() - 1_000),
    attempts: 0,
  };
}

function job(overrides: Partial<ApprovalInteractionJob> = {}): ApprovalInteractionJob {
  return {
    kind: "knowledge_draft_confirmation",
    idempotencyKey: "card-action:event-1",
    eventId: "event-1",
    appId: "cli_app",
    actorOpenId: "ou_actor",
    chatId: "oc_group",
    messageId: "om_card",
    presentationId: "presentation-1",
    draftId: "draft-1",
    revisionNumber: 1,
    draftVersion: 1,
    action: "confirm",
    receivedAt: new Date(at.getTime() - 1000),
    attempts: 0,
    ...overrides,
  } as ApprovalInteractionJob;
}

function presentation(
  overrides: Partial<KnowledgeDraftPresentation> = {},
): KnowledgeDraftPresentation {
  return {
    id: "presentation-1",
    draftId: "draft-1",
    revisionNumber: 1,
    draftVersion: 1,
    chatId: "oc_group",
    contentHash: "a".repeat(64),
    state: "active",
    messageId: "om_card",
    createdAt: at,
    activatedAt: at,
    version: 2,
    ...overrides,
  };
}

function mutationResult(
  outcome: "applied" | "already_applied",
  committedResult: KnowledgeCardCommittedResult = {
    action: "confirm",
    actorOpenId: "ou_actor",
    confirmedAt: at,
    nextGate: "pending_review",
  },
) {
  const status = committedResult.action === "confirm"
    ? "pending_review" as const
    : committedResult.action === "request_revision" ? "needs_revision" as const : "rejected" as const;
  return {
    outcome,
    presentation: presentation({ state: "closed", closedAt: at, version: 3 }),
    draft: {
      id: "draft-1",
      sourceGroupId: "oc_group",
      originKind: "group_conclusion" as const,
      status,
      currentRevisionNumber: 1,
      version: 2,
      createdBy: "iris",
      createdAt: at,
      updatedAt: at,
      currentRevision: {
        revisionNumber: 1,
        riskLevel: "low" as const,
        author: "iris",
        createdAt: at,
        evidenceState: { status: "current" as const },
        title: "Draft title",
        content: "draft body",
        evidence: [],
      },
    },
    committedResult,
  };
}

function committedContext(): KnowledgeCardPresentationContext {
  const mutation = mutationResult("already_applied", {
    action: "request_revision",
    state: "needs_revision",
    reason: "Committed closed reason.",
  });
  return {
    presentation: mutation.presentation,
    draft: mutation.draft,
    evidenceState: mutation.draft.currentRevision.evidenceState,
    committedResult: mutation.committedResult,
  };
}
