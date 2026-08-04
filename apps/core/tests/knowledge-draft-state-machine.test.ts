import { describe, expect, it } from "vitest";

import {
  KnowledgeDraftValidationError,
  normalizeKnowledgeDraftRevisionInput,
} from "../src/knowledge-governance/knowledge-draft.js";
import {
  initialKnowledgeDraftStatus,
  validateKnowledgeDraftTransition,
} from "../src/knowledge-governance/knowledge-draft-state-machine.js";

describe("knowledge draft state machine", () => {
  it("starts a group-scoped draft at group confirmation", () => {
    expect(initialKnowledgeDraftStatus({ sourceGroupId: "oc_group" }))
      .toBe("pending_confirmation");
  });

  it("starts a company-scoped draft at reviewer governance", () => {
    expect(initialKnowledgeDraftStatus({})).toBe("pending_review");
  });

  it.each([
    ["pending_confirmation", "pending_confirmation", "revised", "oc_group"],
    ["pending_review", "pending_review", "revised", undefined],
    ["pending_confirmation", "needs_revision", "revision_requested", "oc_group"],
    ["pending_confirmation", "pending_review", "group_confirmed", "oc_group"],
    ["pending_review", "needs_revision", "revision_requested", undefined],
    ["needs_revision", "pending_confirmation", "revised", "oc_group"],
    ["needs_revision", "pending_review", "revised", undefined],
    ["pending_confirmation", "rejected", "rejected", "oc_group"],
    ["pending_review", "rejected", "rejected", undefined],
    ["needs_revision", "rejected", "rejected", "oc_group"],
  ] as const)("allows %s -> %s through %s", (from, to, eventType, sourceGroupId) => {
    expect(validateKnowledgeDraftTransition({ from, to, eventType, sourceGroupId }))
      .toEqual({ ok: true });
  });

  it("requires group-scoped revisions to return to confirmation", () => {
    expect(validateKnowledgeDraftTransition({
      from: "needs_revision",
      to: "pending_review",
      eventType: "revised",
      sourceGroupId: "oc_group",
    })).toEqual({ ok: false, code: "invalid_knowledge_draft_transition" });
  });

  it.each(["rejected", "published"] as const)("keeps %s terminal", (from) => {
    expect(validateKnowledgeDraftTransition({
      from,
      to: "pending_review",
      eventType: "revised",
    })).toEqual({ ok: false, code: "knowledge_draft_terminal" });
  });

  it("allows an approved publication execution to publish the current draft", () => {
    expect(validateKnowledgeDraftTransition({
      from: "pending_review",
      to: "published",
      eventType: "publication_succeeded",
    })).toEqual({ ok: true });
  });

  it("does not publish through non-publication events", () => {
    expect(validateKnowledgeDraftTransition({
      from: "pending_review",
      to: "published",
      eventType: "revised",
    })).toEqual({ ok: false, code: "invalid_knowledge_draft_transition" });
  });
});

describe("knowledge draft revision validation", () => {
  it("normalizes a bounded group revision and canonical evidence order", () => {
    expect(normalizeKnowledgeDraftRevisionInput({
      sourceGroupId: " oc_group ",
      title: "  Release checklist  ",
      content: "  # Release\n\nRun acceptance.  ",
      riskLevel: "medium",
      reviewer: { type: "feishu_user", ref: " ou_reviewer " },
      suggestedPublication: { spaceId: " spc_1 ", parentNodeToken: " wikcn_parent " },
      evidence: [
        { type: "discussion_thread", id: "thread-1", groupId: "oc_group", entityVersion: 3 },
        { type: "conversation_message", id: "feishu:om_1", groupId: "oc_group" },
      ],
    })).toEqual({
      sourceGroupId: "oc_group",
      title: "Release checklist",
      content: "# Release\n\nRun acceptance.",
      riskLevel: "medium",
      reviewer: { type: "feishu_user", ref: "ou_reviewer" },
      suggestedPublication: { spaceId: "spc_1", parentNodeToken: "wikcn_parent" },
      evidence: [
        { type: "conversation_message", id: "feishu:om_1", groupId: "oc_group" },
        { type: "discussion_thread", id: "thread-1", groupId: "oc_group", entityVersion: 3 },
      ],
    });
  });

  it("accepts company-authorized document evidence without a source group", () => {
    const expectedUpdatedAt = new Date("2026-07-18T00:00:00.000Z");
    expect(normalizeKnowledgeDraftRevisionInput({
      title: "Company FAQ",
      content: "Draft content",
      riskLevel: "low",
      evidence: [{ type: "document_source", id: "source-1", expectedUpdatedAt }],
    }).evidence).toEqual([
      { type: "document_source", id: "source-1", expectedUpdatedAt },
    ]);
  });

  it.each([
    ["blank title", { title: " ", content: "body", riskLevel: "low", evidence: [messageEvidence()] }],
    ["blank content", { title: "title", content: " ", riskLevel: "low", evidence: [messageEvidence()] }],
    ["invalid risk", { title: "title", content: "body", riskLevel: "urgent", evidence: [messageEvidence()] }],
    ["missing evidence", { title: "title", content: "body", riskLevel: "low", evidence: [] }],
    ["duplicate evidence", {
      title: "title",
      content: "body",
      riskLevel: "low",
      sourceGroupId: "oc_group",
      evidence: [messageEvidence(), messageEvidence()],
    }],
    ["mixed group", {
      title: "title",
      content: "body",
      riskLevel: "low",
      sourceGroupId: "oc_group",
      evidence: [{ ...messageEvidence(), groupId: "oc_other" }],
    }],
    ["company group evidence", {
      title: "title",
      content: "body",
      riskLevel: "low",
      evidence: [messageEvidence()],
    }],
    ["invalid entity version", {
      title: "title",
      content: "body",
      riskLevel: "low",
      sourceGroupId: "oc_group",
      evidence: [{ type: "action_item", id: "action-1", groupId: "oc_group", entityVersion: 0 }],
    }],
    ["invalid document date", {
      title: "title",
      content: "body",
      riskLevel: "low",
      evidence: [{ type: "document_source", id: "source-1", expectedUpdatedAt: new Date("invalid") }],
    }],
  ] as const)("rejects %s", (_label, input) => {
    expect(() => normalizeKnowledgeDraftRevisionInput(input as never))
      .toThrow(KnowledgeDraftValidationError);
  });

  it("enforces title, content, and evidence limits", () => {
    expect(() => normalizeKnowledgeDraftRevisionInput({
      title: "x".repeat(257),
      content: "body",
      riskLevel: "low",
      evidence: [{ type: "document_source", id: "source-1", expectedUpdatedAt: new Date() }],
    })).toThrow(KnowledgeDraftValidationError);

    expect(() => normalizeKnowledgeDraftRevisionInput({
      title: "title",
      content: "x".repeat(100_001),
      riskLevel: "low",
      evidence: [{ type: "document_source", id: "source-1", expectedUpdatedAt: new Date() }],
    })).toThrow(KnowledgeDraftValidationError);

    expect(() => normalizeKnowledgeDraftRevisionInput({
      title: "title",
      content: "body",
      riskLevel: "low",
      evidence: Array.from({ length: 101 }, (_, index) => ({
        type: "document_source" as const,
        id: `source-${index}`,
        expectedUpdatedAt: new Date(),
      })),
    })).toThrow(KnowledgeDraftValidationError);
  });
});

function messageEvidence() {
  return { type: "conversation_message" as const, id: "feishu:om_1", groupId: "oc_group" };
}
