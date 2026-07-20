import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  KnowledgeCardPresentationBindingError,
  renderKnowledgeCardCommittedResult,
  renderKnowledgeDraftCard,
} from "../src/knowledge-cards/knowledge-card-renderer.js";
import type { KnowledgeDraft } from "../src/knowledge-governance/knowledge-draft-repository.js";
import type { KnowledgeDraftPresentation } from "../src/knowledge-cards/knowledge-card-repository.js";

describe("renderKnowledgeDraftCard", () => {
  it("renders the complete current revision into a version-bound Feishu JSON 2.0 card", () => {
    const completeBody = "\u5b8c\u6574\u8349\u7a3f\u6b63\u6587\n\nIncludes **Markdown**, \"quotes\", and \\slashes.";
    const rendered = renderedCard({ content: completeBody });
    const card = rendered.card as Record<string, unknown>;
    const body = card.body as { elements: Array<Record<string, unknown>> };

    expect(card).toMatchObject({
      schema: "2.0",
      header: {
        template: "blue",
        title: { tag: "plain_text", content: 'Draft "title"' },
      },
    });
    expect((body.elements.find((element) => element.tag === "markdown" && element.content === completeBody)))
      .toMatchObject({ content: completeBody });
    expect(rendered.json).toContain("\u5b8c\u6574\u8349\u7a3f\u6b63\u6587");
    expect(rendered.json).toContain('\\"title\\"');
    expect(rendered.json).toContain("Risk: medium");
    expect(rendered.json).toContain("Draft revision: 7");
    expect(rendered.json).toContain("Target: Knowledge Base");
    expect(rendered.json).not.toContain("secret evidence text");
    expect(JSON.parse(rendered.json)).toEqual(rendered.card);
    expect(rendered.contentHash).toBe(createHash("sha256").update(rendered.json).digest("hex"));
    expect(rendered.componentCount).toBe(countComponents(body.elements));
    expect(rendered.componentCount).toBeLessThanOrEqual(100);

    expect(buttonValues(body.elements)).toEqual([
      {
        action: "confirm",
        presentationId: "presentation-1",
        draftId: "draft-1",
        revisionNumber: 7,
        draftVersion: 11,
      },
      {
        action: "request_revision",
        presentationId: "presentation-1",
        draftId: "draft-1",
        revisionNumber: 7,
        draftVersion: 11,
      },
      {
        action: "reject",
        presentationId: "presentation-1",
        draftId: "draft-1",
        revisionNumber: 7,
        draftVersion: 11,
      },
    ]);

    const form = body.elements.find((element) => element.tag === "form");
    if (!form || !Array.isArray(form.elements)) throw new Error("expected a card form");
    expect(form.elements.find((element) => isRecord(element) && element.tag === "input")).toMatchObject({
      tag: "input",
      name: "reason",
      input_type: "multiline_text",
      max_length: 1_000,
      required: false,
      label: {
        tag: "plain_text",
        content: "Reason for revision or rejection (at most 1,000 characters)",
      },
    });
    expect(form.elements.some((element) => isRecord(element) && element.tag === "checkbox")).toBe(false);
    const submitButtons = form.elements.filter((element) =>
      isRecord(element) && element.tag === "button"
    );
    expect(submitButtons).toHaveLength(3);
    for (const button of submitButtons) {
      expect(button).toMatchObject({ form_action_type: "submit" });
      expect(button).not.toHaveProperty("action_type");
    }
    expect(form.elements.find((element) => isRecord(element) && element.name === "reject")).toMatchObject({
      tag: "button",
      form_action_type: "submit",
      confirm: {
        title: { tag: "plain_text", content: "Reject draft" },
        text: {
          tag: "plain_text",
          content: "Confirm this irreversible rejection. The submitted reason will be recorded.",
        },
      },
    });
  });

  it("visibly identifies the bounded Iris pending-confirmation draft without source evidence", () => {
    const rendered = renderedCard();
    const body = rendered.card.body as { elements: Array<Record<string, unknown>> };
    const traceability = body.elements.find((element) =>
      element.tag === "markdown" &&
      typeof element.content === "string" &&
      element.content.includes("Iris / pending_confirmation")
    );

    expect(traceability).toEqual({
      tag: "markdown",
      content: [
        "Iris / pending_confirmation",
        "Source type: group_conclusion",
        "Draft ID: draft-1",
        "Draft revision: 7",
        "Draft version: 11",
        "Risk: medium",
        "Target: Knowledge Base",
      ].join("\n"),
    });
    expect([...(traceability!.content as string)].length).toBeLessThanOrEqual(1_000);
    expect(rendered.json).not.toContain("oc_group");
    expect(rendered.json).not.toContain("secret evidence text");
  });

  it("is deterministic and JSON-escapes presentation metadata", () => {
    const input = cardInput({
      title: 'Line one\n"Line two"',
      targetDisplayName: "Target \\ display",
    });

    const first = renderKnowledgeDraftCard(input);
    const second = renderKnowledgeDraftCard(input);

    expect(first).toEqual(second);
    expect(first.status).toBe("rendered");
    if (first.status !== "rendered") throw new Error("expected a rendered card");
    expect(JSON.parse(first.json)).toMatchObject({
      header: { title: { content: 'Line one\n"Line two"' } },
    });
    expect(first.json).toContain("Target \\\\ display");
  });

  it("counts non-BMP body characters by Unicode code point", () => {
    const rendered = renderKnowledgeDraftCard(cardInput({ content: "\u{1F680}".repeat(4_001) }));

    expect(rendered.status).toBe("rendered");
  });

  it.each([
    ["draft ID", { draftId: "other-draft" }],
    ["revision number", { revisionNumber: 8 }],
    ["draft version", { draftVersion: 12 }],
  ] as const)("fails closed when the presentation %s does not bind the rendered draft", (
    _label,
    presentationOverrides,
  ) => {
    expect(() => renderKnowledgeDraftCard(cardInput({ presentationOverrides })))
      .toThrowError(new KnowledgeCardPresentationBindingError());
  });

  it("refuses a body over 8,000 Unicode code points without truncating it", () => {
    const rendered = renderKnowledgeDraftCard(cardInput({ content: "\u4e2d".repeat(8_001) }));

    expect(rendered).toEqual({ status: "review_required", reason: "body_too_large" });
  });

  it("refuses a complete body whose serialized card exceeds 24 KiB", () => {
    const rendered = renderKnowledgeDraftCard(cardInput({ content: "\u4e2d".repeat(8_000) }));

    expect(rendered).toEqual({ status: "review_required", reason: "card_too_large" });
  });
});

describe("renderKnowledgeCardCommittedResult", () => {
  it.each([
    [
      "confirm",
      {
        action: "confirm",
        actorOpenId: "ou_committed_actor",
        confirmedAt: new Date("2026-07-19T03:04:05.000Z"),
        nextGate: "pending_review",
      },
      "pending_review",
      [
        "Iris / confirmed",
        "Result: confirmed",
        "Confirmed by: ou_committed_actor",
        "Confirmed at: 2026-07-19T03:04:05.000Z",
        "Next gate: pending_review",
      ],
    ],
    [
      "request revision",
      {
        action: "request_revision",
        state: "needs_revision",
        reason: "Committed revision reason.",
      },
      "needs_revision",
      [
        "Iris / revision_requested",
        "Result: revision_requested",
        "State: needs_revision",
        "Reason: Committed revision reason.",
      ],
    ],
    [
      "reject",
      {
        action: "reject",
        state: "rejected",
        reason: "Committed rejection reason.",
      },
      "rejected",
      [
        "Iris / rejected",
        "Result: rejected",
        "State: rejected",
        "Reason: Committed rejection reason.",
      ],
    ],
  ] as const)("renders a deterministic content-free %s result from committed facts", (
    _label,
    result,
    draftStatus,
    expectedText,
  ) => {
    const input = {
      presentation: presentation({
        state: "closed",
        messageId: "om_card",
        closedAt: new Date("2026-07-19T03:04:05.000Z"),
        version: 3,
      }),
      draft: { ...draft(), status: draftStatus, version: 12 },
      result,
    };

    const first = renderKnowledgeCardCommittedResult(input);
    const second = renderKnowledgeCardCommittedResult(input);

    expect(second).toBe(first);
    for (const text of [
      ...expectedText,
      "Source type: group_conclusion",
      "Draft ID: draft-1",
      "Draft revision: 7",
      "Draft version: 11",
    ]) expect(first).toContain(text);
    expect(first).not.toMatch(/Full draft body|secret evidence text|oc_group|knowledgeDraftReview/iu);
    expect(JSON.parse(first)).toMatchObject({ schema: "2.0" });
  });
});

function renderedCard(overrides: { content?: string } = {}) {
  const rendered = renderKnowledgeDraftCard(cardInput(overrides));
  if (rendered.status !== "rendered") throw new Error(`expected rendered card, received ${rendered.reason}`);
  return rendered;
}

function cardInput(overrides: {
  content?: string;
  title?: string;
  targetDisplayName?: string;
  presentationOverrides?: Partial<KnowledgeDraftPresentation>;
} = {}) {
  return {
    draft: draft({ content: overrides.content, title: overrides.title }),
    presentation: presentation(overrides.presentationOverrides),
    targetDisplayName: overrides.targetDisplayName ?? "Knowledge Base",
  };
}

function draft(overrides: { content?: string; title?: string } = {}): KnowledgeDraft {
  const now = new Date("2026-07-19T00:00:00.000Z");
  return {
    id: "draft-1",
    sourceGroupId: "oc_group",
    originKind: "group_conclusion",
    status: "pending_confirmation",
    currentRevisionNumber: 7,
    version: 11,
    createdBy: "ou_author",
    createdAt: now,
    updatedAt: now,
    currentRevision: {
      revisionNumber: 7,
      riskLevel: "medium",
      author: "ou_author",
      createdAt: now,
      evidenceState: { status: "current" },
      title: overrides.title ?? 'Draft "title"',
      content: overrides.content ?? "Full draft body.",
      evidence: [{ type: "conversation_message", id: "secret evidence text", groupId: "oc_group" }],
    },
  };
}

function presentation(overrides: Partial<KnowledgeDraftPresentation> = {}): KnowledgeDraftPresentation {
  const now = new Date("2026-07-19T00:00:00.000Z");
  return {
    id: "presentation-1",
    draftId: "draft-1",
    revisionNumber: 7,
    draftVersion: 11,
    chatId: "oc_group",
    contentHash: "a".repeat(64),
    state: "pending_send",
    createdAt: now,
    version: 1,
    ...overrides,
  };
}

function buttonValues(elements: Array<Record<string, unknown>>): unknown[] {
  const form = elements.find((element) => element.tag === "form");
  if (!form || !Array.isArray(form.elements)) return [];
  return form.elements
    .filter((element): element is Record<string, unknown> => isRecord(element) && element.tag === "button")
    .map((button) => button.value);
}

function countComponents(elements: Array<Record<string, unknown>>): number {
  return elements.reduce((count, element) => {
    if (element.tag === "form" && Array.isArray(element.elements)) {
      return count + 1 + countComponents(element.elements.filter(isRecord));
    }
    return count + 1;
  }, 0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
