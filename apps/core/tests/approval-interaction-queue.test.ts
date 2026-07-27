import { describe, expect, it } from "vitest";

import type {
  ApprovalInteractionDeadLetter,
  ApprovalInteractionQueue,
} from "../src/knowledge-cards/approval-interaction-queue.js";
import {
  normalizeApprovalInteractionIntentIdentity,
  normalizeApprovalInteractionJob,
  type ApprovalInteractionJob,
} from "../src/knowledge-cards/knowledge-card.js";

describe("ApprovalInteractionQueue contract", () => {
  it("publishes the exact worker and operator surface", async () => {
    const queue = {
      enqueue: async () => "enqueued" as const,
      claimBatch: async () => [] as ApprovalInteractionJob[],
      acknowledge: async () => undefined,
      handleFailure: async () => ({ action: "delayed" as const }),
      getCounts: async () => ({ pending: 0, processing: 0, delayed: 0, deadLetter: 0 }),
      listDeadLetters: async () => [] as ApprovalInteractionDeadLetter[],
      replayDeadLetter: async () => "not_found" as const,
      deleteDeadLetter: async () => "not_found" as const,
    } satisfies ApprovalInteractionQueue;

    await expect(queue.getCounts()).resolves.toEqual({
      pending: 0,
      processing: 0,
      delayed: 0,
      deadLetter: 0,
    });
  });

  it("normalizes a content-free proactive feedback job without accepting legacy intent fields", () => {
    const feedback = {
      kind: "proactive_signal_feedback",
      idempotencyKey: "feishu-card:cli_feedback:event-1",
      eventId: "event-1",
      appId: "cli_feedback",
      actorOpenId: "ou_member",
      chatId: "oc_group",
      messageId: "om_reminder",
      presentationId: "delivery-1",
      deliveryId: "delivery-1",
      candidateIdempotencyKey: "quiet_open_thread:thread-1:2",
      entityVersion: 2,
      action: "helpful",
      receivedAt: new Date("2026-07-27T00:00:00.000Z"),
      attempts: 0,
    };

    expect(normalizeApprovalInteractionJob(feedback)).toEqual(feedback);
    expect(normalizeApprovalInteractionIntentIdentity(feedback)).toEqual({
      kind: "proactive_signal_feedback",
      idempotencyKey: "feishu-card:cli_feedback:event-1",
      eventId: "event-1",
      appId: "cli_feedback",
      actorOpenId: "ou_member",
      chatId: "oc_group",
      messageId: "om_reminder",
      presentationId: "delivery-1",
      deliveryId: "delivery-1",
      candidateIdempotencyKey: "quiet_open_thread:thread-1:2",
      entityVersion: 2,
      action: "helpful",
    });
    expect(() => normalizeApprovalInteractionJob({ ...feedback, action: "confirm" })).toThrow(
      "action is invalid",
    );
    expect(() => normalizeApprovalInteractionJob({ ...feedback, entityVersion: 2.5 })).toThrow(
      "entityVersion must be a safe positive integer",
    );
    expect(() => normalizeApprovalInteractionJob({ ...feedback, intentId: "intent-1" })).toThrow(
      "unknown approval interaction field: intentId",
    );
    expect(() => normalizeApprovalInteractionJob({ ...feedback, reason: "not accepted" })).toThrow(
      "unknown approval interaction field: reason",
    );
  });
});
