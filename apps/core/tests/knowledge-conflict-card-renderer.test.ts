import { describe, expect, it } from "vitest";

import {
  KNOWLEDGE_CONFLICT_CARD_JSON_MAX_BYTES,
  KNOWLEDGE_CONFLICT_CARD_MAX_COMPONENTS,
  createKnowledgeConflictCallbackNonce,
  renderKnowledgeConflictCard,
} from "../src/knowledge-conflicts/knowledge-conflict-card-renderer.js";
import type { DocumentSource } from "../src/documents/document-source-registry.js";
import type { KnowledgeConflictCandidate } from "../src/knowledge-conflicts/knowledge-conflict.js";

const at = new Date("2026-08-15T01:00:00.000Z");

describe("KnowledgeConflictCardRenderer", () => {
  it("renders a bounded no-winner card with both sides, target, evidence labels, and exact version-bound actions", () => {
    const result = renderKnowledgeConflictCard({
      candidate: candidate(),
      source: source(),
      nonce: "nonce-1",
    });

    expect(result.componentCount).toBeLessThanOrEqual(KNOWLEDGE_CONFLICT_CARD_MAX_COMPONENTS);
    expect(Buffer.byteLength(result.json, "utf8")).toBeLessThanOrEqual(
      KNOWLEDGE_CONFLICT_CARD_JSON_MAX_BYTES,
    );
    const visible = markdownContent(result.card);
    expect(visible).toContain("Possible knowledge conflict");
    expect(visible).toContain("No winner has been selected");
    expect(visible).toContain("Director approval starts at CNY 5,000\\.");
    expect(visible).toContain("Director approval now starts at CNY 10,000\\.");
    expect(visible).toContain("The approval threshold differs\\.");
    expect(visible).toContain("Replace CNY 5,000 with CNY 10,000\\.");
    expect(visible).toContain("Expense policy");
    expect(visible).toContain("revision\\-7");
    expect(visible).toContain("Document evidence: D1");
    expect(visible).toContain("Group evidence: M1, C1");
    expect(visible).toContain("https://example.feishu.cn/wiki/expense-policy");

    const buttons = findButtons(result.card);
    expect(buttons).toHaveLength(2);
    expect(callbackValue(buttons[0]!)).toEqual({
      kind: "knowledge_conflict_confirmation",
      action: "create_update_draft",
      candidateId: "candidate-1",
      candidateVersion: "3",
      groupId: "oc_group",
      nonce: "nonce-1",
    });
    expect(callbackValue(buttons[1]!)).toEqual({
      kind: "knowledge_conflict_confirmation",
      action: "not_a_conflict",
      candidateId: "candidate-1",
      candidateVersion: "3",
      groupId: "oc_group",
      nonce: "nonce-1",
    });
  });

  it("uses replacement wording and metadata only for an exact managed update target", () => {
    const result = renderKnowledgeConflictCard({
      candidate: candidate(),
      source: source(),
      nonce: "nonce-1",
      managedUpdateTarget: {
        managedPageId: "managed-1",
        managedPageVersion: 4,
        expectedRemoteRevisionId: "12",
      },
    });

    const visible = markdownContent(result.card);
    expect(visible).toMatch(/replace existing managed page/iu);
    expect(visible).toContain("managed\\-1");
    expect(visible).toContain("12");
    expect(result.json).not.toMatch(/current body|proposed body|content hash/iu);
  });

  it("uses publication wording when no exact managed update target exists", () => {
    const result = renderKnowledgeConflictCard({
      candidate: candidate(),
      source: source(),
      nonce: "nonce-1",
    });

    const visible = markdownContent(result.card);
    expect(visible).toMatch(/publish a new managed page/iu);
    expect(visible).not.toMatch(/replace existing managed page/iu);
  });

  it("treats all visible text as untrusted, omits hidden facts, and excludes unsafe links", () => {
    const malicious = candidate({
      plan: {
        ...candidate().plan,
        subject: "**winner** [click](https://evil.invalid) <at user_id=ou_hidden>",
        knowledgeBaseStatement: "`prompt` **official** <script>alert(1)</script>",
      },
    }) as KnowledgeConflictCandidate & {
      prompt: string;
      actorOpenId: string;
      token: string;
    };
    malicious.prompt = "hidden-system-prompt";
    malicious.actorOpenId = "ou_secret_actor";
    malicious.token = "bearer_secret_token";

    const result = renderKnowledgeConflictCard({
      candidate: malicious,
      source: source({
        sourceUri: "https://user:password@example.feishu.cn/wiki/expense-policy",
        title: "[target](https://evil.invalid)",
      }),
      nonce: createKnowledgeConflictCallbackNonce("delivery-1"),
    });

    const visible = markdownContent(result.card);
    expect(visible).toContain("\\*\\*winner\\*\\*");
    expect(visible).toContain("\\[click\\]\\(https://evil\\.invalid\\)");
    expect(visible).not.toContain("<script>");
    expect(result.json).not.toContain("https://user:password@");
    expect(result.json).not.toMatch(/hidden-system-prompt|ou_secret_actor|bearer_secret_token/u);
    expect(result.json).not.toContain("message-1");
    expect(result.json).not.toContain("fragment-1");
  });

  it("truncates maximal candidate text without exceeding Feishu byte or component limits", () => {
    const longText = "审批🔒".repeat(1_000);
    const result = renderKnowledgeConflictCard({
      candidate: candidate({
        plan: {
          ...candidate().plan,
          subject: longText,
          knowledgeBaseStatement: longText,
          groupConclusionStatement: longText,
          difference: longText,
          suggestedUpdate: longText,
        },
      }),
      source: source({ title: longText }),
      nonce: "nonce-1",
    });

    expect(result.componentCount).toBeLessThanOrEqual(KNOWLEDGE_CONFLICT_CARD_MAX_COMPONENTS);
    expect(Buffer.byteLength(result.json, "utf8")).toBeLessThanOrEqual(
      KNOWLEDGE_CONFLICT_CARD_JSON_MAX_BYTES,
    );
    expect(result.json).toContain("…");
  });

  it.each([
    ["non-approved candidate", candidate({ status: "pending_review" })],
    ["non-positive version", candidate({ version: 0 })],
    ["wrong source", candidate()],
    ["control-character candidate identifier", candidate({ id: "candidate\n1" })],
  ] as const)("rejects a %s binding", (_label, value) => {
    expect(() => renderKnowledgeConflictCard({
      candidate: value,
      source: _label === "wrong source" ? source({ id: "source-2" }) : source(),
      nonce: "nonce-1",
    })).toThrow("knowledge conflict card binding");
  });

  it("rejects a control-character callback nonce", () => {
    expect(() => renderKnowledgeConflictCard({
      candidate: candidate(),
      source: source(),
      nonce: "nonce\n1",
    })).toThrow("knowledge conflict card binding");
  });

  it.each([
    ["leading C0 candidate ID", candidate({ id: "\ncandidate-1" }), "nonce-1"],
    ["trailing whitespace candidate ID", candidate({ id: "candidate-1 " }), "nonce-1"],
    ["leading whitespace group ID", candidate({ groupId: " oc_group" }), "nonce-1"],
    ["NFC-changing candidate ID", candidate({ id: "candidate-e\u0301" }), "nonce-1"],
    ["trailing C0 nonce", candidate(), "nonce-1\t"],
    ["leading Unicode whitespace nonce", candidate(), "\u00a0nonce-1"],
    ["NFC-changing nonce", candidate(), "nonce-e\u0301"],
  ] as const)("rejects a %s instead of silently changing callback identity", (_label, value, nonce) => {
    expect(() => renderKnowledgeConflictCard({
      candidate: value,
      source: source(),
      nonce,
    })).toThrow("knowledge conflict card binding");
  });

  it.each([
    "\ndelivery-1",
    "delivery-1 ",
    "delivery-e\u0301",
  ])("rejects an inexact delivery identifier before deriving its callback nonce: %s", (deliveryId) => {
    expect(() => createKnowledgeConflictCallbackNonce(deliveryId))
      .toThrow("knowledge conflict card binding");
  });

  it("strips C1 controls from visible text and rejects them in callback identifiers", () => {
    const result = renderKnowledgeConflictCard({
      candidate: candidate({
        plan: { ...candidate().plan, subject: "Expense\u0085threshold" },
      }),
      source: source(),
      nonce: "nonce-1",
    });
    expect(markdownContent(result.card)).toContain("Expense threshold");
    expect(result.json).not.toContain("\u0085");

    expect(() => renderKnowledgeConflictCard({
      candidate: candidate({ id: "candidate\u00851" }),
      source: source(),
      nonce: "nonce-1",
    })).toThrow("knowledge conflict card binding");
  });

  it.each([
    ["C0 lower bound", "\u0000candidate-1"],
    ["C0 upper bound", "candidate-1\u001f"],
    ["DEL boundary", "candidate\u007f-1"],
    ["C1 lower bound", "candidate\u0080-1"],
    ["C1 upper bound", "candidate-1\u009f"],
  ])("rejects the %s in callback identifiers", (_label, id) => {
    expect(() => renderKnowledgeConflictCard({
      candidate: candidate({ id }),
      source: source(),
      nonce: "nonce-1",
    })).toThrow("knowledge conflict card binding");
  });

  it.each([
    "https://example.feishu.cn/wiki/expense\u0000-policy",
    "https://example.feishu.cn/wiki/expense\u001f-policy",
    "https://example.feishu.cn/wiki/expense\u007f-policy",
    "https://example.feishu.cn/wiki/expense\u0080-policy",
    "https://example.feishu.cn/wiki/expense\u009f-policy",
    "https://example.feishu.cn/wiki/expense\u0085-policy",
    "https://example.feishu.cn/wiki/expense\n-policy",
    "https://example.feishu.cn/wiki/expense%00-policy",
    "https://example.feishu.cn/wiki/expense%1F-policy",
    "https://example.feishu.cn/wiki/expense%7F-policy",
    "https://example.feishu.cn/wiki/expense%C2%80-policy",
    "https://example.feishu.cn/wiki/expense%C2%9F-policy",
    "https://example.feishu.cn/wiki/expense policy",
    "https://example.feishu.cn/wiki/expense%0A-policy",
    "https://example.feishu.cn/wiki/expense\uFEFF-policy",
    "https://example.feishu.cn/wiki/expense%EF%BB%BF-policy",
    "https://example.feishu.cn/wiki/expense%zz-policy",
    "https:example.feishu.cn/wiki/expense-policy",
    "https:/example.feishu.cn/wiki/expense-policy",
    "https:\\example.feishu.cn/wiki/expense-policy",
    "HTTPS://example.feishu.cn/wiki/expense-policy",
    "https://example.feishu.cn/wiki/expense%20policy",
    "https://example.feishu.cn/wiki/expense%09policy",
    "https://example.feishu.cn/wiki/expense%C2%A0policy",
    " https://example.feishu.cn/wiki/expense-policy",
    "https://example.feishu.cn/wiki/expense-policy ",
    "\u00a0https://example.feishu.cn/wiki/expense-policy",
  ])("suppresses a control, whitespace, or malformed-percent URI instead of canonicalizing it: %s", (sourceUri) => {
    const result = renderKnowledgeConflictCard({
      candidate: candidate(),
      source: source({ sourceUri }),
      nonce: "nonce-1",
    });

    const visible = markdownContent(result.card);
    expect(visible).toContain("**Target:** Expense policy");
    expect(visible).not.toContain("](https://");
  });

  it.each([
    "https://example.feishu.cn/wiki/expense-policy",
    "https://example.feishu.cn/wiki/expense%2Dpolicy?revision=7&locale=zh-CN",
    "https://example.feishu.cn/wiki/%E5%AE%A1%E6%89%B9?view=compact",
  ])("preserves a valid credential-free HTTPS source URI: %s", (sourceUri) => {
    const result = renderKnowledgeConflictCard({
      candidate: candidate(),
      source: source({ sourceUri }),
      nonce: "nonce-1",
    });

    expect(markdownContent(result.card)).toContain(`](${sourceUri})`);
  });
});

function candidate(
  overrides: Partial<KnowledgeConflictCandidate> = {},
): KnowledgeConflictCandidate {
  return {
    id: "candidate-1",
    idempotencyKey: "candidate-operation-1",
    groupId: "oc_group",
    groupMemoryId: "memory-1",
    memoryUpdatedAt: at,
    sourceMessageId: "message-1",
    targetDocumentSourceId: "source-1",
    targetSourceUpdatedAt: at,
    targetSourceVersion: "revision-7",
    targetSnapshotId: "snapshot-1",
    targetContentHash: "a".repeat(64),
    detectorContractVersion: "knowledge-conflict-v1",
    status: "approved_for_delivery",
    plan: {
      outcome: "conflict",
      subject: "Expense approval threshold",
      knowledgeBaseStatement: "Director approval starts at CNY 5,000.",
      knowledgeBaseCitationRefs: ["D1"],
      groupConclusionStatement: "Director approval now starts at CNY 10,000.",
      groupCitationRefs: ["M1", "C1"],
      difference: "The approval threshold differs.",
      suggestedUpdate: "Replace CNY 5,000 with CNY 10,000.",
      targetDocumentRef: "D1",
      missingEvidence: [],
      confidence: "high",
    },
    evidence: [
      { type: "conversation_message", referenceId: "C1", groupId: "oc_group", conversationMessageId: "message-1" },
      { type: "group_memory", referenceId: "M1", groupId: "oc_group", groupMemoryId: "memory-1", expectedUpdatedAt: at },
      { type: "document_source", referenceId: "D1", documentSourceId: "source-1", expectedUpdatedAt: at },
      { type: "document_snapshot", referenceId: "D1", documentSourceId: "source-1", documentSnapshotId: "snapshot-1", contentHash: "a".repeat(64) },
      { type: "document_fragment", referenceId: "D1", documentSourceId: "source-1", documentSnapshotId: "snapshot-1", documentFragmentId: "fragment-1", snapshotContentHash: "a".repeat(64), contentHash: "b".repeat(64) },
    ],
    version: 2,
    createdAt: at,
    updatedAt: at,
    ...overrides,
  };
}

function source(overrides: Partial<DocumentSource> = {}): DocumentSource {
  return {
    id: "source-1",
    sourceType: "authorized_wiki_document",
    sourceUri: "https://example.feishu.cn/wiki/expense-policy",
    title: "Expense policy",
    authorizedSpaceId: "space-1",
    permissionState: "readable",
    syncState: "synced",
    canUseForAnswering: true,
    canUseForKnowledgeDrafts: true,
    createdAt: at,
    updatedAt: at,
    evidence: [],
    ...overrides,
  };
}

function findButtons(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.flatMap(findButtons);
  if (!isRecord(value)) return [];
  return [
    ...(value.tag === "button" ? [value] : []),
    ...Object.values(value).flatMap(findButtons),
  ];
}

function markdownContent(value: unknown): string {
  if (Array.isArray(value)) return value.map(markdownContent).join("\n");
  if (!isRecord(value)) return "";
  return [
    ...(value.tag === "markdown" && typeof value.content === "string" ? [value.content] : []),
    ...Object.values(value).map(markdownContent),
  ].join("\n");
}

function callbackValue(button: Record<string, unknown>): unknown {
  const behaviors = button.behaviors;
  if (!Array.isArray(behaviors) || !isRecord(behaviors[0])) {
    throw new Error("expected callback behavior");
  }
  return behaviors[0].value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
