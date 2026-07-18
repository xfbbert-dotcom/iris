import { describe, expect, it, vi } from "vitest";

import { createApprovalInteractionWorker } from "../src/knowledge-cards/approval-interaction-worker.js";
import type { ApprovalInteractionJob } from "../src/knowledge-cards/knowledge-card.js";
import type { KnowledgeDraftPresentation } from "../src/knowledge-cards/knowledge-card-repository.js";
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
    ["stale_presentation", { presentation: presentation({ state: "closed" }) }],
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

  it.each([
    [new KnowledgeCardPersistenceConflictError(), "stale_presentation"],
    [new KnowledgeCardMembershipProofError(), "invalid_membership_evidence"],
    [new KnowledgeDraftEvidenceError("message_deleted"), "evidence_invalidated"],
    [new KnowledgeCardOperationConflictError(), "duplicate_callback"],
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
      job: job({ action: "request_revision", reason: "Clarify ownership." }),
    });
    const rejection = createHarness({
      job: job({ action: "reject", reason: "Conflicts with policy.", rejectionConfirmed: true }),
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
  isCurrentMember?: () => Promise<boolean>;
  applyInteraction?: (...args: any[]) => Promise<any>;
  updateCard?: () => Promise<void>;
  acknowledge?: () => Promise<void>;
  handleFailure?: () => Promise<{ action: "delayed" | "dead_lettered" }>;
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
    applyInteraction: vi.fn(overrides.applyInteraction ?? (async () => mutationResult("applied"))),
  };
  const membershipChecker = {
    isCurrentMember: vi.fn(overrides.isCurrentMember ?? (async () => true)),
  };
  const cardClient = {
    updateCard: vi.fn(overrides.updateCard ?? (async () => undefined)),
  };
  return {
    queue,
    repository,
    membershipChecker,
    cardClient,
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
    }),
  };
}

function job(overrides: Partial<ApprovalInteractionJob> = {}): ApprovalInteractionJob {
  return {
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

function mutationResult(outcome: "applied" | "already_applied") {
  return {
    outcome,
    presentation: presentation({ state: "closed", closedAt: at, version: 3 }),
    draft: {
      id: "draft-1",
      sourceGroupId: "oc_group",
      originKind: "group_conclusion" as const,
      status: "pending_review" as const,
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
  };
}
