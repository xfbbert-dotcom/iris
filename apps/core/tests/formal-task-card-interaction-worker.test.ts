import { describe, expect, it, vi } from "vitest";

import { createFormalTaskCardInteractionWorker } from
  "../src/formal-tasks/formal-task-card-interaction-worker.js";
import type { FormalTaskCardPresentationContext } from
  "../src/formal-tasks/formal-task-card-repository.js";
import type { FormalTaskDraftConfirmationInteractionJob } from
  "../src/knowledge-cards/knowledge-card.js";

const at = new Date("2026-08-22T06:00:00.000Z");

describe("FormalTaskCardInteractionWorker", () => {
  it("rechecks both runtime gates and current group membership before applying an exact callback", async () => {
    const gates = [true, true];
    const fixture = createFixture({ canUse: () => gates.shift() ?? false });

    await expect(fixture.worker.processInteraction(job())).resolves.toEqual({
      status: "applied",
      code: "formal_task_action_applied",
    });
    expect(fixture.membershipChecker.isCurrentMember).toHaveBeenCalledWith({
      chatId: "oc_pilot",
      openId: "ou_reviewer",
    });
    expect(fixture.repository.applyInteraction).toHaveBeenCalledWith({
      presentationId: "task-presentation-1",
      draftId: "task-draft-1",
      draftRevision: 1,
      draftVersion: 1,
      taskSpecHash: "a".repeat(64),
      targetPolicyId: "task-policy-1",
      targetPolicyVersion: 3,
      groupId: "oc_pilot",
      eventId: "event-task-1",
      actorOpenId: "ou_reviewer",
      membershipCheckedAt: at,
      at,
      action: "confirm",
    });
    expect(fixture.cardClient.updateCard).toHaveBeenCalledWith(expect.objectContaining({
      messageId: "om_task",
      cardJson: expect.stringContaining("No Feishu task has been created yet."),
    }));
  });

  it("returns an idempotent replay without applying a second logical action", async () => {
    const fixture = createFixture({ outcome: "already_applied" });

    await expect(fixture.worker.processInteraction(job())).resolves.toEqual({
      status: "already_applied",
      code: "duplicate_callback",
    });
  });

  it("fails closed for the bot, nonmembers, and a runtime flip", async () => {
    const bot = createFixture({ botOpenId: "ou_reviewer" });
    const nonmember = createFixture({ isMember: false });
    const gates = [true, false];
    const flipped = createFixture({ canUse: () => gates.shift() ?? false });

    await expect(bot.worker.processInteraction(job())).resolves.toEqual({
      status: "denied",
      code: "bot_actor",
    });
    await expect(nonmember.worker.processInteraction(job())).resolves.toEqual({
      status: "denied",
      code: "not_current_member",
    });
    await expect(flipped.worker.processInteraction(job())).resolves.toEqual({
      status: "denied",
      code: "runtime_disabled",
    });
    expect(bot.repository.applyInteraction).not.toHaveBeenCalled();
    expect(nonmember.repository.applyInteraction).not.toHaveBeenCalled();
    expect(flipped.repository.applyInteraction).not.toHaveBeenCalled();
  });

  it("retries when current group membership cannot be verified", async () => {
    const fixture = createFixture({ membershipError: true });

    await expect(fixture.worker.processInteraction(job())).resolves.toEqual({
      status: "retryable",
      code: "membership_unavailable",
    });
    expect(fixture.repository.applyInteraction).not.toHaveBeenCalled();
  });

  it("denies a stale callback binding before membership lookup", async () => {
    const fixture = createFixture({
      context: context({ presentation: { taskSpecHash: "b".repeat(64) } }),
    });

    await expect(fixture.worker.processInteraction(job())).resolves.toEqual({
      status: "denied",
      code: "stale_presentation",
    });
    expect(fixture.membershipChecker.isCurrentMember).not.toHaveBeenCalled();
  });

  it("requires an immutable intent for revision or rejection", async () => {
    const fixture = createFixture();

    await expect(fixture.worker.processInteraction(job({ action: "request_revision" }))).resolves.toEqual({
      status: "denied",
      code: "immutable_intent_conflict",
    });
    expect(fixture.repository.applyInteraction).not.toHaveBeenCalled();
  });
});

function createFixture(overrides: {
  botOpenId?: string;
  canUse?: () => boolean;
  isMember?: boolean;
  membershipError?: boolean;
  outcome?: "applied" | "already_applied";
  context?: FormalTaskCardPresentationContext;
} = {}) {
  const initial = overrides.context ?? context();
  const committed = context({
    presentation: { state: "closed", closedAt: at, version: 3 },
    draftStatus: "pending_review",
    committedResult: {
      action: "confirm",
      actorOpenId: "ou_reviewer",
      confirmedAt: at,
      nextGate: "pending_review",
    },
  });
  const repository = {
    getPresentationContext: vi.fn(async () => initial),
    applyInteraction: vi.fn(async () => ({
      outcome: overrides.outcome ?? "applied",
      presentation: committed.presentation,
      draft: committed.draft,
      committedResult: committed.committedResult!,
    })),
  };
  const membershipChecker = {
    isCurrentMember: vi.fn(async () => {
      if (overrides.membershipError) throw new Error("membership unavailable");
      return overrides.isMember ?? true;
    }),
  };
  const cardClient = { updateCard: vi.fn(async () => undefined) };
  return {
    repository,
    membershipChecker,
    cardClient,
    worker: createFormalTaskCardInteractionWorker({
      repository,
      membershipChecker,
      cardClient,
      canUseFormalTaskCards: overrides.canUse ?? (() => true),
      botOpenId: overrides.botOpenId ?? "ou_bot",
      now: () => at,
    }),
  };
}

function job(
  overrides: Partial<FormalTaskDraftConfirmationInteractionJob> = {},
): FormalTaskDraftConfirmationInteractionJob {
  return {
    kind: "formal_task_draft_confirmation",
    idempotencyKey: "feishu-card:cli_a:event-task-1",
    eventId: "event-task-1",
    appId: "cli_a",
    actorOpenId: "ou_reviewer",
    chatId: "oc_pilot",
    messageId: "om_task",
    presentationId: "task-presentation-1",
    draftId: "task-draft-1",
    revisionNumber: 1,
    draftVersion: 1,
    taskSpecHash: "a".repeat(64),
    targetPolicyId: "task-policy-1",
    targetPolicyVersion: 3,
    action: "confirm",
    receivedAt: at,
    attempts: 0,
    ...overrides,
  };
}

function context(overrides: {
  presentation?: Partial<FormalTaskCardPresentationContext["presentation"]>;
  draftStatus?: "pending_confirmation" | "pending_review";
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
      state: "active",
      messageId: "om_task",
      createdAt: at,
      activatedAt: at,
      version: 2,
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
          description: "Collect governed evidence.",
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
      version: 3,
      createdAt: at,
      updatedAt: at,
    },
    ...(overrides.committedResult === undefined ? {} : { committedResult: overrides.committedResult }),
  };
}
