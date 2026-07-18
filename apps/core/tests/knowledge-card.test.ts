import { describe, expect, it } from "vitest";

import {
  KNOWLEDGE_CARD_ACTIONS,
  KNOWLEDGE_CARD_BODY_MAX_CODE_POINTS,
  KNOWLEDGE_CARD_JSON_MAX_BYTES,
  KNOWLEDGE_CARD_MAX_COMPONENTS,
  KNOWLEDGE_CARD_PRESENTATION_STATES,
  KNOWLEDGE_CARD_REASON_MAX_CHARS,
  KnowledgeCardValidationError,
  normalizeApprovalInteractionJob,
} from "../src/knowledge-cards/knowledge-card.js";

describe("knowledge card contracts", () => {
  it("publishes the bounded card constants", () => {
    expect(KNOWLEDGE_CARD_ACTIONS).toEqual(["confirm", "request_revision", "reject"]);
    expect(KNOWLEDGE_CARD_PRESENTATION_STATES).toEqual([
      "pending_send",
      "active",
      "superseded",
      "closed",
      "send_failed",
    ]);
    expect(KNOWLEDGE_CARD_REASON_MAX_CHARS).toBe(2_000);
    expect(KNOWLEDGE_CARD_BODY_MAX_CODE_POINTS).toBe(8_000);
    expect(KNOWLEDGE_CARD_JSON_MAX_BYTES).toBe(24 * 1024);
    expect(KNOWLEDGE_CARD_MAX_COMPONENTS).toBe(100);
  });

  it("normalizes a confirmation job without carrying draft content", () => {
    const receivedAt = new Date("2026-07-19T00:00:00.000Z");
    const job = normalizeApprovalInteractionJob({
      idempotencyKey: " feishu-card:cli_a:event-1 ",
      eventId: " event-1 ",
      appId: " cli_a ",
      actorOpenId: " ou_actor ",
      chatId: " oc_group ",
      presentationId: " presentation-1 ",
      draftId: " draft-1 ",
      revisionNumber: 2,
      draftVersion: 3,
      action: "confirm",
      receivedAt,
      attempts: 0,
    });

    expect(job).toMatchObject({
      action: "confirm",
      draftId: "draft-1",
      idempotencyKey: "feishu-card:cli_a:event-1",
    });
    expect(job.receivedAt).toEqual(receivedAt);
    expect(job.receivedAt).not.toBe(receivedAt);
    expect(job).not.toHaveProperty("content");
  });

  it("parses an ISO receivedAt value from durable queue storage", () => {
    expect(normalizeApprovalInteractionJob({
      ...validJob(),
      receivedAt: "2026-07-19T00:00:00.000Z",
    })).toMatchObject({
      receivedAt: new Date("2026-07-19T00:00:00.000Z"),
    });
  });

  it.each([
    ["request_revision", { reason: "  Add rollback steps.  " }],
    ["reject", { reason: "  Unsafe.  ", rejectionConfirmed: true }],
  ] as const)("requires the bounded payload for %s", (action, extra) => {
    expect(normalizeApprovalInteractionJob({
      ...validJob(),
      action,
      ...extra,
    })).toMatchObject({ action, reason: extra.reason.trim() });
  });

  it.each([
    ["request revision without a reason", { action: "request_revision" }],
    ["rejection without a reason", { action: "reject", rejectionConfirmed: true }],
    ["rejection without confirmation", { action: "reject", reason: "Unsafe" }],
    ["unsafe integer", { revisionNumber: 1.5 }],
    ["unknown field", { content: "draft body" }],
  ])("rejects %s", (_label, extra) => {
    expect(() => normalizeApprovalInteractionJob({ ...validJob(), ...extra }))
      .toThrow(KnowledgeCardValidationError);
  });
});

function validJob() {
  return {
    idempotencyKey: "feishu-card:cli_a:event-1",
    eventId: "event-1",
    appId: "cli_a",
    actorOpenId: "ou_actor",
    chatId: "oc_group",
    presentationId: "presentation-1",
    draftId: "draft-1",
    revisionNumber: 2,
    draftVersion: 3,
    action: "confirm" as const,
    receivedAt: new Date("2026-07-19T00:00:00.000Z"),
    attempts: 0,
  };
}
