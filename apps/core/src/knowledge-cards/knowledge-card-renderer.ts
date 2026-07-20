import { createHash } from "node:crypto";

import {
  KNOWLEDGE_CARD_BODY_MAX_CODE_POINTS,
  KNOWLEDGE_CARD_JSON_MAX_BYTES,
  KNOWLEDGE_CARD_MAX_COMPONENTS,
  KNOWLEDGE_CARD_REASON_MAX_CHARS,
  type KnowledgeCardAction,
} from "./knowledge-card.js";
import type {
  KnowledgeCardCommittedResult,
  KnowledgeDraftPresentation,
} from "./knowledge-card-repository.js";
import {
  KNOWLEDGE_DRAFT_REASON_MAX_CHARS,
  KNOWLEDGE_DRAFT_REFERENCE_MAX_CHARS,
} from "../knowledge-governance/knowledge-draft.js";
import type { KnowledgeDraft } from "../knowledge-governance/knowledge-draft-repository.js";

const FEISHU_INPUT_MAX_LENGTH = 1_000;

export type KnowledgeDraftCardRenderInput = {
  draft: KnowledgeDraft;
  presentation: KnowledgeDraftPresentation;
  targetDisplayName: string;
};

export type KnowledgeCardCommittedResultRenderInput = {
  draft: KnowledgeDraft;
  presentation: KnowledgeDraftPresentation;
  result: KnowledgeCardCommittedResult;
};

export type KnowledgeDraftCardRenderResult =
  | {
      status: "rendered";
      card: Record<string, unknown>;
      json: string;
      contentHash: string;
      componentCount: number;
    }
  | {
      status: "review_required";
      reason: "body_too_large" | "card_too_large" | "too_many_components";
    };

export class KnowledgeCardPresentationBindingError extends Error {
  constructor() {
    super("knowledge card presentation does not match draft");
    this.name = "KnowledgeCardPresentationBindingError";
  }
}

export function renderKnowledgeDraftCard(
  input: KnowledgeDraftCardRenderInput,
): KnowledgeDraftCardRenderResult {
  if (
    input.presentation.draftId !== input.draft.id ||
    input.presentation.revisionNumber !== input.draft.currentRevisionNumber ||
    input.presentation.draftVersion !== input.draft.version
  ) throw new KnowledgeCardPresentationBindingError();
  const revision = input.draft.currentRevision;
  if (!("content" in revision)) {
    throw new Error("knowledge card requires a current draft revision");
  }
  if ([...revision.content].length > KNOWLEDGE_CARD_BODY_MAX_CODE_POINTS) {
    return { status: "review_required", reason: "body_too_large" };
  }

  let componentCount = 0;
  const component = <T extends Record<string, unknown>>(value: T): T => {
    componentCount += 1;
    return value;
  };
  const callbackValue = (action: KnowledgeCardAction) => ({
    action,
    presentationId: input.presentation.id,
    draftId: input.draft.id,
    revisionNumber: String(input.presentation.revisionNumber),
    draftVersion: String(input.presentation.draftVersion),
  });

  const formElements: Record<string, unknown>[] = [
    component({
      tag: "input",
      name: "reason",
      input_type: "multiline_text",
      rows: 3,
      max_length: Math.min(KNOWLEDGE_CARD_REASON_MAX_CHARS, FEISHU_INPUT_MAX_LENGTH),
      required: false,
      label: {
        tag: "plain_text",
        content: "Reason for revision or rejection (at most 1,000 characters)",
      },
      placeholder: { tag: "plain_text", content: "Describe the required change or rejection reason" },
    }),
    component({
      tag: "button",
      name: "confirm",
      text: { tag: "plain_text", content: "Confirm" },
      type: "primary",
      form_action_type: "submit",
      behaviors: [{ type: "callback", value: callbackValue("confirm") }],
    }),
    component({
      tag: "button",
      name: "request_revision",
      text: { tag: "plain_text", content: "Request revision" },
      type: "default",
      form_action_type: "submit",
      behaviors: [{ type: "callback", value: callbackValue("request_revision") }],
    }),
    component({
      tag: "button",
      name: "reject",
      text: { tag: "plain_text", content: "Reject" },
      type: "danger",
      form_action_type: "submit",
      behaviors: [{ type: "callback", value: callbackValue("reject") }],
      confirm: {
        title: { tag: "plain_text", content: "Reject draft" },
        text: {
          tag: "plain_text",
          content: "Confirm this irreversible rejection. The submitted reason will be recorded.",
        },
      },
    }),
  ];
  const metadata = [
    `Iris / ${input.draft.status}`,
    `Source type: ${input.draft.originKind}`,
    `Draft ID: ${input.draft.id}`,
    `Draft revision: ${input.presentation.revisionNumber}`,
    `Draft version: ${input.presentation.draftVersion}`,
    `Risk: ${revision.riskLevel}`,
    `Target: ${input.targetDisplayName}`,
  ].join("\n");
  const bodyElements: Record<string, unknown>[] = [
    component({ tag: "markdown", content: metadata }),
    component({ tag: "markdown", content: revision.content }),
    component({ tag: "form", name: "knowledgeDraftReview", elements: formElements }),
  ];

  if (componentCount > KNOWLEDGE_CARD_MAX_COMPONENTS) {
    return { status: "review_required", reason: "too_many_components" };
  }

  const card: Record<string, unknown> = {
    schema: "2.0",
    header: {
      template: "blue",
      title: { tag: "plain_text", content: revision.title },
    },
    body: { elements: bodyElements },
  };
  const json = JSON.stringify(card);
  if (Buffer.byteLength(json, "utf8") > KNOWLEDGE_CARD_JSON_MAX_BYTES) {
    return { status: "review_required", reason: "card_too_large" };
  }

  return {
    status: "rendered",
    card,
    json,
    contentHash: createHash("sha256").update(json).digest("hex"),
    componentCount,
  };
}

export function renderKnowledgeCardCommittedResult(
  input: KnowledgeCardCommittedResultRenderInput,
): string {
  if (
    input.presentation.state !== "closed" ||
    input.presentation.draftId !== input.draft.id
  ) throw new KnowledgeCardPresentationBindingError();

  const metadata = [
    `Source type: ${input.draft.originKind}`,
    `Draft ID: ${input.presentation.draftId}`,
    `Draft revision: ${input.presentation.revisionNumber}`,
    `Draft version: ${input.presentation.draftVersion}`,
  ];
  let marker: string;
  let title: string;
  let template: "green" | "orange" | "red";
  let outcome: string[];

  if (input.result.action === "confirm") {
    marker = "confirmed";
    title = "Knowledge draft confirmed";
    template = "green";
    outcome = [
      "Result: confirmed",
      `Confirmed by: ${requireBoundedResultText(
        "actorOpenId",
        input.result.actorOpenId,
        KNOWLEDGE_DRAFT_REFERENCE_MAX_CHARS,
      )}`,
      `Confirmed at: ${requireResultDate(input.result.confirmedAt).toISOString()}`,
      `Next gate: ${input.result.nextGate}`,
    ];
  } else if (input.result.action === "request_revision") {
    marker = "revision_requested";
    title = "Knowledge draft revision requested";
    template = "orange";
    outcome = [
      "Result: revision_requested",
      `State: ${input.result.state}`,
      `Reason: ${requireBoundedResultText(
        "reason",
        input.result.reason,
        KNOWLEDGE_DRAFT_REASON_MAX_CHARS,
      )}`,
    ];
  } else {
    marker = "rejected";
    title = "Knowledge draft rejected";
    template = "red";
    outcome = [
      "Result: rejected",
      `State: ${input.result.state}`,
      `Reason: ${requireBoundedResultText(
        "reason",
        input.result.reason,
        KNOWLEDGE_DRAFT_REASON_MAX_CHARS,
      )}`,
    ];
  }

  const json = JSON.stringify({
    schema: "2.0",
    header: {
      template,
      title: { tag: "plain_text", content: title },
    },
    body: {
      elements: [{
        tag: "markdown",
        content: [`Iris / ${marker}`, ...metadata, ...outcome].join("\n"),
      }],
    },
  });
  if (Buffer.byteLength(json, "utf8") > KNOWLEDGE_CARD_JSON_MAX_BYTES) {
    throw new Error("knowledge card committed result is too large");
  }
  return json;
}

function requireBoundedResultText(name: string, value: string, maximum: number): string {
  if (typeof value !== "string" || value.trim().length === 0 || [...value].length > maximum) {
    throw new Error(`knowledge card committed ${name} is invalid`);
  }
  return value;
}

function requireResultDate(value: Date): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new Error("knowledge card committed date is invalid");
  }
  return value;
}
