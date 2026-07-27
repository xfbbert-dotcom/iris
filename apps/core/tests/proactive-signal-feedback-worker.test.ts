import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { createProactiveSignalFeedbackWorker } from "../src/proactive-signals/proactive-signal-feedback-worker.js";
import type { ApprovalInteractionJob } from "../src/knowledge-cards/knowledge-card.js";
import type { ProactiveSignalRepository } from "../src/proactive-signals/proactive-signal-repository.js";

const at = new Date("2026-07-27T00:00:00.000Z");

describe("ProactiveSignalFeedbackWorker", () => {
  it("records helpful feedback for a current member of an enabled group", async () => {
    const harness = createHarness();

    await expect(harness.worker.processFeedback(feedbackJob())).resolves.toEqual({
      status: "applied",
      code: "feedback_applied",
    });
    expect(harness.membershipChecker.isCurrentMember).toHaveBeenCalledWith({
      chatId: "oc_group",
      openId: "ou_actor",
    });
    expect(harness.repository.recordFeedback).toHaveBeenCalledWith({
      idempotencyKey: "card-action:feedback-event-1",
      deliveryId: "delivery-1",
      candidateIdempotencyKey: "quiet_open_thread:thread-1:2",
      groupId: "oc_group",
      messageId: "om_card",
      entityVersion: 2,
      actorFingerprint: createHash("sha256").update("cli_app:ou_actor").digest("hex"),
      feedback: "helpful",
      suppressUntil: at,
      at,
    });
  });

  it("normalizes identifiers before membership and repository I/O", async () => {
    const harness = createHarness();

    await harness.worker.processFeedback(feedbackJob({
      idempotencyKey: " card-action:feedback-event-1 ",
      appId: " cli_app ",
      actorOpenId: " ou_actor ",
      chatId: " oc_group ",
      messageId: " om_card ",
      deliveryId: " delivery-1 ",
      candidateIdempotencyKey: " quiet_open_thread:thread-1:2 ",
    }));

    expect(harness.membershipChecker.isCurrentMember).toHaveBeenCalledWith({
      chatId: "oc_group",
      openId: "ou_actor",
    });
    expect(harness.repository.recordFeedback).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: "card-action:feedback-event-1",
      deliveryId: "delivery-1",
      candidateIdempotencyKey: "quiet_open_thread:thread-1:2",
      groupId: "oc_group",
      messageId: "om_card",
      actorFingerprint: createHash("sha256").update("cli_app:ou_actor").digest("hex"),
    }));
  });

  it("computes the irrelevant suppression deadline from configured days", async () => {
    const harness = createHarness({ suppressionDays: 45 });

    await expect(harness.worker.processFeedback(feedbackJob({
      action: "irrelevant",
    }))).resolves.toEqual({
      status: "applied",
      code: "feedback_applied",
    });
    expect(harness.repository.recordFeedback).toHaveBeenCalledWith(expect.objectContaining({
      feedback: "irrelevant",
      suppressUntil: new Date("2026-09-10T00:00:00.000Z"),
      at,
    }));
  });

  it.each([
    ["disabled runtime", { canProactivelySpeak: () => false }, "runtime_disabled"],
    ["bot actor", { job: feedbackJob({ actorOpenId: "ou_bot" }) }, "bot_actor"],
    ["non-member", { isCurrentMember: async () => false }, "not_current_member"],
    [
      "stale binding",
      { recordFeedback: async () => ({ status: "stale_binding" as const }) },
      "stale_delivery",
    ],
  ] as const)("returns a stable denial for %s", async (_label, overrides, code) => {
    const harness = createHarness(overrides);
    const input = "job" in overrides ? overrides.job : feedbackJob();

    await expect(harness.worker.processFeedback(input)).resolves.toEqual({
      status: "denied",
      code,
    });
  });

  it.each([
    [
      "membership exception",
      { isCurrentMember: async () => { throw new Error("membership unavailable"); } },
      "membership_unavailable",
    ],
    [
      "repository exception",
      { recordFeedback: async () => { throw new Error("repository unavailable"); } },
      "repository_unavailable",
    ],
  ] as const)("classifies a %s as retryable", async (_label, overrides, code) => {
    const harness = createHarness(overrides);

    await expect(harness.worker.processFeedback(feedbackJob())).resolves.toEqual({
      status: "retryable",
      code,
    });
  });

  it("checks the runtime gate before membership I/O and immediately before mutation", async () => {
    const order: string[] = [];
    const harness = createHarness({
      canProactivelySpeak: () => {
        order.push("gate");
        return true;
      },
      isCurrentMember: async () => {
        order.push("membership");
        return true;
      },
      recordFeedback: async () => {
        order.push("mutation");
        return { status: "applied" as const };
      },
    });

    await harness.worker.processFeedback(feedbackJob());

    expect(order).toEqual(["gate", "membership", "gate", "mutation"]);
  });

  it("does not mutate when the runtime is disabled after membership", async () => {
    let enabled = true;
    const harness = createHarness({
      canProactivelySpeak: () => {
        const result = enabled;
        enabled = false;
        return result;
      },
    });

    await expect(harness.worker.processFeedback(feedbackJob())).resolves.toEqual({
      status: "denied",
      code: "runtime_disabled",
    });
    expect(harness.membershipChecker.isCurrentMember).toHaveBeenCalledOnce();
    expect(harness.repository.recordFeedback).not.toHaveBeenCalled();
  });

  it("never passes raw actor identity to recordFeedback", async () => {
    const harness = createHarness();

    await harness.worker.processFeedback(feedbackJob());

    const mutation = harness.repository.recordFeedback.mock.calls[0]?.[0];
    expect(JSON.stringify(mutation)).not.toContain("ou_actor");
    expect(mutation).not.toHaveProperty("actorOpenId");
  });

  it("maps an idempotent repository result to duplicate feedback", async () => {
    const harness = createHarness({
      recordFeedback: async () => ({ status: "already_applied" }),
    });

    await expect(harness.worker.processFeedback(feedbackJob())).resolves.toEqual({
      status: "already_applied",
      code: "duplicate_feedback",
    });
  });
});

type FeedbackJob = Extract<ApprovalInteractionJob, { kind: "proactive_signal_feedback" }>;

type HarnessOverrides = {
  job?: FeedbackJob;
  suppressionDays?: number;
  canProactivelySpeak?: (groupId: string) => boolean;
  isCurrentMember?: () => Promise<boolean>;
  recordFeedback?: ProactiveSignalRepository["recordFeedback"];
};

function createHarness(overrides: HarnessOverrides = {}) {
  const repository = {
    recordFeedback: vi.fn(overrides.recordFeedback ?? (async () => ({ status: "applied" as const }))),
  };
  const membershipChecker = {
    isCurrentMember: vi.fn(overrides.isCurrentMember ?? (async () => true)),
  };
  return {
    repository,
    membershipChecker,
    worker: createProactiveSignalFeedbackWorker({
      repository,
      membershipChecker,
      canProactivelySpeak: overrides.canProactivelySpeak ?? (() => true),
      botOpenId: "ou_bot",
      suppressionDays: overrides.suppressionDays ?? 30,
      now: () => new Date(at),
    }),
  };
}

function feedbackJob(overrides: Partial<FeedbackJob> = {}): FeedbackJob {
  return {
    kind: "proactive_signal_feedback",
    idempotencyKey: "card-action:feedback-event-1",
    eventId: "feedback-event-1",
    appId: "cli_app",
    actorOpenId: "ou_actor",
    chatId: "oc_group",
    messageId: "om_card",
    presentationId: "delivery-1",
    deliveryId: "delivery-1",
    candidateIdempotencyKey: "quiet_open_thread:thread-1:2",
    entityVersion: 2,
    action: "helpful",
    receivedAt: new Date("2026-07-26T23:59:00.000Z"),
    attempts: 0,
    ...overrides,
  };
}
