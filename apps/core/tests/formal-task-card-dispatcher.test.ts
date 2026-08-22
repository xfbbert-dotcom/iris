import { describe, expect, it, vi } from "vitest";

import { FeishuInteractiveCardClientError } from
  "../src/feishu/feishu-interactive-card-client.js";
import {
  createFormalTaskCardDispatcher,
} from "../src/formal-tasks/formal-task-card-dispatcher.js";
import type {
  FormalTaskCardPresentationContext,
  FormalTaskCardRepository,
  FormalTaskCardSendClaim,
} from "../src/formal-tasks/formal-task-card-repository.js";

const at = new Date("2026-08-22T06:00:00.000Z");

describe("FormalTaskCardDispatcher", () => {
  it("rechecks the exact task context and runtime before sending one idempotent group card", async () => {
    const harness = dispatcherHarness();

    await expect(harness.dispatcher.processBatch({ limit: 1 })).resolves.toEqual([{
      status: "sent",
      presentationId: "task-presentation-1",
      code: "send_succeeded",
    }]);
    expect(harness.repository.beginExternalAttempt).toHaveBeenCalledOnce();
    expect(harness.cardClient.sendCard).toHaveBeenCalledWith({
      chatId: "oc_pilot",
      cardJson: expect.stringContaining("Prepare acceptance report"),
      uuid: expect.stringMatching(/^[a-f0-9]{50}$/u),
    });
    expect(harness.repository.completePresentationSend).toHaveBeenCalledWith({
      presentationId: "task-presentation-1",
      workerId: "task-card-dispatcher",
      messageId: "om_task_card",
      at,
    });
  });

  it("fails preparation without an external attempt when runtime or policy is stale", async () => {
    const disabled = dispatcherHarness({ canUse: false });
    await expect(disabled.dispatcher.processBatch({ limit: 1 })).resolves.toEqual([{
      status: "permanent_failure",
      presentationId: "task-presentation-1",
      code: "runtime_disabled",
    }]);
    expect(disabled.cardClient.sendCard).not.toHaveBeenCalled();
    expect(disabled.repository.failPresentationPreparation).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: "runtime_disabled" }),
    );

    const stalePolicy = dispatcherHarness({ policyVersion: 4 });
    await expect(stalePolicy.dispatcher.processBatch({ limit: 1 })).resolves.toEqual([{
      status: "permanent_failure",
      presentationId: "task-presentation-1",
      code: "stale_policy",
    }]);
    expect(stalePolicy.cardClient.sendCard).not.toHaveBeenCalled();
  });

  it("never blindly retries an unknown Feishu send outcome", async () => {
    const harness = dispatcherHarness({
      sendError: new FeishuInteractiveCardClientError("outcome_unknown", "timeout"),
    });

    await expect(harness.dispatcher.processBatch({ limit: 1 })).resolves.toEqual([{
      status: "outcome_unknown",
      presentationId: "task-presentation-1",
      code: "outcome_unknown",
    }]);
    expect(harness.repository.failPresentationSend).toHaveBeenCalledWith({
      presentationId: "task-presentation-1",
      workerId: "task-card-dispatcher",
      classification: "outcome_unknown",
      errorCode: "outcome_unknown",
      at,
    });
  });

  it("uses the durable outbox to update a closed card after an interaction", async () => {
    const closedContext = context({
      presentation: {
        state: "closed",
        messageId: "om_task_card",
        closedAt: at,
        version: 3,
      },
      draftStatus: "pending_review",
      committedResult: {
        action: "confirm",
        actorOpenId: "ou_member",
        confirmedAt: at,
        nextGate: "pending_review",
      },
    });
    const harness = dispatcherHarness({ context: closedContext });

    await expect(harness.dispatcher.processBatch({ limit: 1 })).resolves.toEqual([{
      status: "updated",
      presentationId: "task-presentation-1",
      code: "card_update_succeeded",
    }]);
    expect(harness.cardClient.updateCard).toHaveBeenCalledWith({
      messageId: "om_task_card",
      cardJson: expect.stringContaining("Formal task draft confirmed"),
    });
    expect(harness.cardClient.sendCard).not.toHaveBeenCalled();
  });
});

function dispatcherHarness(overrides: {
  canUse?: boolean;
  policyVersion?: number;
  sendError?: Error;
  context?: FormalTaskCardPresentationContext;
} = {}) {
  const currentContext = overrides.context ?? context({ policyVersion: overrides.policyVersion });
  const claim: FormalTaskCardSendClaim = {
    presentation: currentContext.presentation,
    workerId: "task-card-dispatcher",
    leaseUntil: new Date(at.getTime() + 30_000),
    attempts: 1,
  };
  let claimed = false;
  const repository = {
    claimPresentationSend: vi.fn(async () => {
      if (claimed) return undefined;
      claimed = true;
      return claim;
    }),
    getPresentationContext: vi.fn(async () => currentContext),
    beginExternalAttempt: vi.fn(async () => undefined),
    failPresentationPreparation: vi.fn(async () => undefined),
    completePresentationSend: vi.fn(async () => undefined),
    failPresentationSend: vi.fn(async () => undefined),
  } as unknown as FormalTaskCardRepository;
  const cardClient = {
    sendCard: vi.fn(async () => {
      if (overrides.sendError !== undefined) throw overrides.sendError;
      return { messageId: "om_task_card" };
    }),
    updateCard: vi.fn(async () => undefined),
  };
  return {
    repository,
    cardClient,
    dispatcher: createFormalTaskCardDispatcher({
      repository,
      cardClient,
      canUseFormalTaskCards: () => overrides.canUse ?? true,
      workerId: "task-card-dispatcher",
      leaseMs: 30_000,
      retryDelayMs: 1_000,
      now: () => at,
    }),
  };
}

function context(overrides: {
  presentation?: Partial<FormalTaskCardPresentationContext["presentation"]>;
  draftStatus?: "pending_confirmation" | "pending_review";
  policyVersion?: number;
  committedResult?: FormalTaskCardPresentationContext["committedResult"];
} = {}): FormalTaskCardPresentationContext {
  const hash = "a".repeat(64);
  return {
    presentation: {
      id: "task-presentation-1",
      draftId: "task-draft-1",
      draftRevision: 1,
      draftVersion: 1,
      taskSpecHash: hash,
      groupId: "oc_pilot",
      state: "pending_send",
      createdAt: at,
      version: 1,
      ...overrides.presentation,
    },
    draft: {
      id: "task-draft-1",
      sourceGroupId: "oc_pilot",
      status: overrides.draftStatus ?? "pending_confirmation",
      currentRevisionNumber: 1,
      version: overrides.draftStatus === "pending_review" ? 2 : 1,
      createdBy: "iris",
      currentTaskSpecHash: hash,
      createdAt: at,
      updatedAt: at,
      currentRevision: {
        revisionNumber: 1,
        riskLevel: "high",
        author: "iris",
        taskSpecHash: hash,
        createdAt: at,
        evidenceState: { status: "current" },
        taskSpec: {
          title: "Prepare acceptance report",
          description: "Collect the governed pilot evidence.",
          assigneeOpenId: "ou_assignee",
          dueAtUtc: "2026-08-24T09:30:00.000Z",
          reminderMinutes: 30,
          sourceGroupId: "oc_pilot",
          targetPolicyId: "task-policy-1",
          targetPolicyVersion: 3,
        },
        evidence: [{ type: "conversation_message", id: "feishu:om_1" }],
      },
    },
    targetPolicy: {
      id: "task-policy-1",
      sourceGroupId: "oc_pilot",
      displayName: "Pilot task policy",
      allowedAssigneeOpenIds: ["ou_assignee"],
      maxDueHorizonDays: 30,
      enabled: true,
      version: overrides.policyVersion ?? 3,
      createdAt: at,
      updatedAt: at,
    },
    ...(overrides.committedResult === undefined
      ? {}
      : { committedResult: overrides.committedResult }),
  };
}
