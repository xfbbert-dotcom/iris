import { describe, expect, it, vi } from "vitest";

import {
  createActionApprovalDispatcher,
} from "../src/action-approvals/action-approval-dispatcher.js";
import type {
  ActionApprovalDeliveryContext,
  ActionApprovalSendClaim,
} from "../src/action-approvals/action-proposal-repository.js";
import {
  FeishuInteractiveCardClientError,
} from "../src/feishu/feishu-interactive-card-client.js";

const at = new Date("2026-07-20T02:00:00.000Z");

describe("ActionApprovalDispatcher", () => {
  it("sends one fresh version-bound card to the exact recipient in order", async () => {
    const order: string[] = [];
    const harness = createHarness({
      getContext: async () => {
        order.push("context");
        return deliveryContext();
      },
      canDeliver: () => {
        order.push("gate");
        return true;
      },
      begin: async () => {
        order.push("begin");
      },
      send: async (input) => {
        order.push("send");
        expect(input.recipientOpenId).toBe("ou_owner");
        expect(input.cardJson).toContain("Approve knowledge publication");
        expect(input.uuid).toHaveLength(50);
        return { messageId: "om_approval" };
      },
      complete: async () => {
        order.push("complete");
      },
    });

    await expect(harness.dispatcher.processBatch({ limit: 1 })).resolves.toEqual([{
      status: "sent",
      presentationId: "proposal-presentation-1",
      code: "send_succeeded",
    }]);
    expect(order).toEqual(["context", "gate", "begin", "gate", "send", "complete"]);
    expect(harness.repository.completeApprovalPresentationSend).toHaveBeenCalledWith({
      presentationId: "proposal-presentation-1",
      workerId: "approval-dispatcher-1",
      messageId: "om_approval",
      at,
    });
  });

  it("stops when no presentation is ready", async () => {
    const harness = createHarness({ claim: undefined });
    await expect(harness.dispatcher.processBatch({ limit: 10 })).resolves.toEqual([]);
    expect(harness.repository.getApprovalDeliveryContext).not.toHaveBeenCalled();
  });

  it.each([
    ["missing context", undefined, "stale_presentation"],
    ["changed proposal version", deliveryContext({ proposalVersion: 5 }), "stale_presentation"],
    ["disabled gate", deliveryContext(), "runtime_disabled"],
  ] as const)("fails preparation for %s", async (_label, context, code) => {
    const harness = createHarness({
      getContext: async () => context,
      canDeliver: () => code !== "runtime_disabled",
    });
    await expect(harness.dispatcher.processBatch({ limit: 1 })).resolves.toEqual([{
      status: "permanent_failure",
      presentationId: "proposal-presentation-1",
      code,
    }]);
    expect(harness.repository.failApprovalPresentationPreparation).toHaveBeenCalledWith({
      presentationId: "proposal-presentation-1",
      workerId: "approval-dispatcher-1",
      errorCode: code,
      at,
    });
    expect(harness.cardClient.sendCardToUser).not.toHaveBeenCalled();
  });

  it.each([
    ["request_not_sent", "retrying", "request_not_sent"],
    ["retryable_remote_failure", "retrying", "retryable_remote_failure"],
    ["remote_rejected", "permanent_failure", "remote_rejected"],
    ["outcome_unknown", "outcome_unknown", "outcome_unknown"],
  ] as const)("classifies %s without leaking remote details", async (classification, status, code) => {
    const harness = createHarness({
      send: async () => {
        throw new FeishuInteractiveCardClientError(classification, "safe_code");
      },
    });
    const result = await harness.dispatcher.processBatch({ limit: 1 });
    expect(result).toEqual([{
      status,
      presentationId: "proposal-presentation-1",
      code,
    }]);
    expect(harness.repository.failApprovalPresentationSend).toHaveBeenCalledWith(expect.objectContaining({
      presentationId: "proposal-presentation-1",
      classification: status === "retrying" ? "retryable" : status === "permanent_failure"
        ? "permanent" : "outcome_unknown",
      errorCode: code,
    }));
    expect(JSON.stringify(result)).not.toContain("safe_code");
  });

  it("fails closed if the runtime gate changes before dispatch", async () => {
    let reads = 0;
    const harness = createHarness({ canDeliver: () => ++reads === 1 });
    await expect(harness.dispatcher.processBatch({ limit: 1 })).resolves.toEqual([{
      status: "permanent_failure",
      presentationId: "proposal-presentation-1",
      code: "runtime_disabled",
    }]);
    expect(harness.repository.beginApprovalExternalAttempt).toHaveBeenCalledOnce();
    expect(harness.cardClient.sendCardToUser).not.toHaveBeenCalled();
  });

  it("rechecks the exact source-group gate before sending", async () => {
    const canDeliver = vi.fn((sourceGroupId?: string) => sourceGroupId === "oc_group");
    const harness = createHarness({
      getContext: async () => ({
        ...deliveryContext(),
        sourceGroupId: "oc_group",
      } as ActionApprovalDeliveryContext),
      canDeliver,
    });

    await expect(harness.dispatcher.processBatch({ limit: 1 })).resolves.toEqual([{
      status: "sent",
      presentationId: "proposal-presentation-1",
      code: "send_succeeded",
    }]);
    expect(canDeliver).toHaveBeenNthCalledWith(1, "oc_group");
    expect(canDeliver).toHaveBeenNthCalledWith(2, "oc_group");
  });

  it("bounds batch size and claims sequentially", async () => {
    const harness = createHarness({ claim: undefined });
    await harness.dispatcher.processBatch({ limit: 1_000 });
    expect(harness.repository.claimApprovalPresentationSend).toHaveBeenCalledWith({
      workerId: "approval-dispatcher-1",
      at,
      leaseUntil: new Date(at.getTime() + 30_000),
    });
    await expect(harness.dispatcher.processBatch({ limit: Number.POSITIVE_INFINITY }))
      .rejects.toThrow("batch limit");
  });
});

type HarnessOverrides = {
  claim?: ActionApprovalSendClaim;
  getContext?: () => Promise<ActionApprovalDeliveryContext | undefined>;
  canDeliver?: (sourceGroupId?: string) => boolean;
  begin?: () => Promise<void>;
  send?: (input: { recipientOpenId: string; cardJson: string; uuid: string }) => Promise<{ messageId: string }>;
  complete?: () => Promise<void>;
};

function createHarness(overrides: HarnessOverrides = {}) {
  const repository = {
    claimApprovalPresentationSend: vi.fn(async () =>
      Object.hasOwn(overrides, "claim") ? overrides.claim : sendClaim()),
    getApprovalDeliveryContext: vi.fn(overrides.getContext ?? (async () => deliveryContext())),
    beginApprovalExternalAttempt: vi.fn(overrides.begin ?? (async () => undefined)),
    failApprovalPresentationPreparation: vi.fn(async () => undefined),
    completeApprovalPresentationSend: vi.fn(overrides.complete ?? (async () => undefined)),
    failApprovalPresentationSend: vi.fn(async () => undefined),
  };
  const cardClient = {
    sendCardToUser: vi.fn(overrides.send ?? (async () => ({ messageId: "om_approval" }))),
  };
  return {
    repository,
    cardClient,
    dispatcher: createActionApprovalDispatcher({
      repository,
      cardClient,
      canDeliverApprovalCards: overrides.canDeliver ?? (() => true),
      workerId: "approval-dispatcher-1",
      leaseMs: 30_000,
      retryDelayMs: 60_000,
      now: () => new Date(at),
    }),
  };
}

function sendClaim(): ActionApprovalSendClaim {
  return {
    presentation: deliveryContext().presentation,
    workerId: "approval-dispatcher-1",
    leaseUntil: new Date(at.getTime() + 30_000),
    attempts: 1,
  };
}

function deliveryContext(overrides: { proposalVersion?: number } = {}): ActionApprovalDeliveryContext {
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
  const proposalVersion = overrides.proposalVersion ?? 4;
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
        operationKey: "publish-knowledge:draft-1:2:3",
        version: proposalVersion,
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
      allowedGroupIds: ["oc_group"],
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
      state: "pending_send",
      operationKey: "action-presentation:proposal-1:requirement-1:ou_owner:4",
      version: 1,
      createdAt,
    },
  };
}
