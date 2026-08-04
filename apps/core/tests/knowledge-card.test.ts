import { describe, expect, it, vi } from "vitest";

import {
  ACTION_PROPOSAL_CARD_ACTIONS,
  APPROVAL_INTERACTION_KINDS,
  KNOWLEDGE_CARD_ACTIONS,
  KNOWLEDGE_CARD_BODY_MAX_CODE_POINTS,
  KNOWLEDGE_CARD_JSON_MAX_BYTES,
  KNOWLEDGE_CARD_MAX_COMPONENTS,
  KNOWLEDGE_CARD_PRESENTATION_STATES,
  KNOWLEDGE_CARD_REASON_MAX_CHARS,
  KnowledgeCardValidationError,
  normalizeApprovalInteractionJob,
  normalizeApprovalInteractionIntentIdentity,
} from "../src/knowledge-cards/knowledge-card.js";
import { createPostgresApprovalInteractionIntentStore } from
  "../src/knowledge-cards/postgres-approval-interaction-intent-store.js";
import type { ApplyKnowledgeCardInteractionInput } from "../src/knowledge-cards/knowledge-card-repository.js";
import type { PostgresKnowledgeDraftDataSource } from
  "../src/knowledge-governance/postgres-knowledge-draft-repository.js";

describe("knowledge card contracts", () => {
  it("publishes the bounded card constants", () => {
    expect(KNOWLEDGE_CARD_ACTIONS).toEqual(["confirm", "request_revision", "reject"]);
    expect(ACTION_PROPOSAL_CARD_ACTIONS).toEqual(["approve", "request_revision", "reject"]);
    expect(APPROVAL_INTERACTION_KINDS).toEqual([
      "knowledge_draft_confirmation",
      "action_proposal_approval",
      "proactive_signal_feedback",
    ]);
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
      kind: "knowledge_draft_confirmation",
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
      kind: "knowledge_draft_confirmation",
      action: "confirm",
      draftId: "draft-1",
      idempotencyKey: "feishu-card:cli_a:event-1",
    });
    expect(job.receivedAt).toEqual(receivedAt);
    expect(job.receivedAt).not.toBe(receivedAt);
    expect(job).not.toHaveProperty("content");
  });

  it("normalizes a content-free action proposal approval job", () => {
    const job = normalizeApprovalInteractionJob({
      kind: "action_proposal_approval",
      idempotencyKey: "feishu-card:cli_a:event-2",
      eventId: "event-2",
      appId: "cli_a",
      actorOpenId: "ou_owner",
      chatId: "oc_group",
      messageId: "om_proposal",
      presentationId: "proposal-presentation-1",
      proposalId: "proposal-1",
      requirementId: "requirement-1",
      proposalVersion: 4,
      subjectRevision: 2,
      subjectVersion: 7,
      targetPolicyVersion: 3,
      action: "approve",
      receivedAt: new Date("2026-07-19T00:00:00.000Z"),
      attempts: 0,
    });

    expect(job).toMatchObject({
      kind: "action_proposal_approval",
      action: "approve",
      proposalId: "proposal-1",
      proposalVersion: 4,
      targetPolicyVersion: 3,
    });
    expect(job).not.toHaveProperty("draftId");
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
    ["request_revision", { intentId: " intent-revision " }],
    ["reject", { intentId: " intent-rejection " }],
  ] as const)("requires an opaque intent reference for %s", (action, extra) => {
    expect(normalizeApprovalInteractionJob({
      ...validJob(),
      action,
      ...extra,
    })).toMatchObject({ action, intentId: extra.intentId.trim() });
  });

  it.each([
    ["request revision without an intent", { action: "request_revision" }],
    ["rejection without an intent", { action: "reject" }],
    ["unsafe integer", { revisionNumber: 1.5 }],
    ["unknown field", { content: "draft body" }],
    ["missing interaction kind", { kind: undefined }],
    ["mixed proposal field", { proposalId: "proposal-1" }],
    ["reason in the queue", { action: "request_revision", intentId: "intent-1", reason: "not allowed" }],
    ["rejection confirmation in the queue", {
      action: "reject",
      intentId: "intent-1",
      rejectionConfirmed: true,
    }],
    ["intent on confirmation", { intentId: "not allowed" }],
  ])("rejects %s", (_label, extra) => {
    expect(() => normalizeApprovalInteractionJob({ ...validJob(), ...extra }))
      .toThrow(KnowledgeCardValidationError);
  });

  it("bounds durable revision reasons by Unicode code points outside the queue", async () => {
    const acceptedReason = "\u{1F680}".repeat(KNOWLEDGE_CARD_REASON_MAX_CHARS);
    const rejectedReason = "\u{1F680}".repeat(KNOWLEDGE_CARD_REASON_MAX_CHARS + 1);
    const query = vi.fn(async () => ({ rows: [{ id: "intent-1" }] }));
    const store = createPostgresApprovalInteractionIntentStore({
      dataSource: { query } as unknown as PostgresKnowledgeDraftDataSource,
      idGenerator: () => "intent-1",
    });
    const interaction = normalizeApprovalInteractionIntentIdentity({
      ...validJob(),
      action: "request_revision",
    });

    await expect(store.persistIntent({
      interaction,
      reason: acceptedReason,
      at: new Date("2026-07-19T00:00:00.000Z"),
    })).resolves.toEqual({ id: "intent-1" });
    await expect(store.persistIntent({
      interaction,
      reason: rejectedReason,
      at: new Date("2026-07-19T00:00:00.000Z"),
    })).rejects.toThrow(/reason length is invalid/iu);
    expect(query).toHaveBeenCalledOnce();
  });
});

const confirmInteraction = {
  ...validInteraction(),
  action: "confirm",
} satisfies ApplyKnowledgeCardInteractionInput;

const revisionInteraction = {
  ...validInteraction(),
  action: "request_revision",
  reason: "Add rollback steps.",
} satisfies ApplyKnowledgeCardInteractionInput;

const rejectionInteraction = {
  ...validInteraction(),
  action: "reject",
  reason: "Unsafe.",
  rejectionConfirmed: true,
} satisfies ApplyKnowledgeCardInteractionInput;

const invalidRevisionInteraction = {
  ...validInteraction(),
  action: "request_revision",
} as const;

const invalidRejectionInteraction = {
  ...validInteraction(),
  action: "reject",
  reason: "Unsafe.",
} as const;

// @ts-expect-error request_revision requires a reason.
const missingRevisionReason: ApplyKnowledgeCardInteractionInput = invalidRevisionInteraction;

// @ts-expect-error reject requires both a reason and explicit confirmation.
const missingRejectionConfirmation: ApplyKnowledgeCardInteractionInput = invalidRejectionInteraction;

void confirmInteraction;
void revisionInteraction;
void rejectionInteraction;
void invalidRevisionInteraction;
void invalidRejectionInteraction;
void missingRevisionReason;
void missingRejectionConfirmation;

function validJob() {
  return {
    kind: "knowledge_draft_confirmation" as const,
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

function validInteraction() {
  return {
    presentationId: "presentation-1",
    draftId: "draft-1",
    revisionNumber: 2,
    draftVersion: 3,
    chatId: "oc_group",
    eventId: "event-1",
    actorOpenId: "ou_actor",
    membershipCheckedAt: new Date("2026-07-19T00:00:00.000Z"),
    at: new Date("2026-07-19T00:00:00.000Z"),
  };
}
