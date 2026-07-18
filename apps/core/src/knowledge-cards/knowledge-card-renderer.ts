import { createHash } from "node:crypto";

import {
  KNOWLEDGE_CARD_BODY_MAX_CODE_POINTS,
  KNOWLEDGE_CARD_JSON_MAX_BYTES,
  KNOWLEDGE_CARD_MAX_COMPONENTS,
  KNOWLEDGE_CARD_REASON_MAX_CHARS,
  type KnowledgeCardAction,
} from "./knowledge-card.js";
import type { KnowledgeDraftPresentation } from "./knowledge-card-repository.js";
import type { KnowledgeDraft } from "../knowledge-governance/knowledge-draft-repository.js";

const FEISHU_INPUT_MAX_LENGTH = 1_000;

export type KnowledgeDraftCardRenderInput = {
  draft: KnowledgeDraft;
  presentation: KnowledgeDraftPresentation;
  targetDisplayName: string;
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

export function renderKnowledgeDraftCard(
  input: KnowledgeDraftCardRenderInput,
): KnowledgeDraftCardRenderResult {
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
    revisionNumber: input.presentation.revisionNumber,
    draftVersion: input.presentation.draftVersion,
  });

  const formElements: Record<string, unknown>[] = [
    component({
      tag: "input",
      name: "reason",
      input_type: "multiline_text",
      rows: 3,
      max_length: Math.min(KNOWLEDGE_CARD_REASON_MAX_CHARS, FEISHU_INPUT_MAX_LENGTH),
      required: false,
      label: { tag: "plain_text", content: "Reason for revision or rejection" },
      placeholder: { tag: "plain_text", content: "Describe the required change or rejection reason" },
    }),
    component({
      tag: "checkbox",
      name: "rejectionConfirmed",
      options: [{
        text: { tag: "plain_text", content: "I confirm this rejection" },
        value: "true",
      }],
    }),
    component({
      tag: "button",
      name: "confirm",
      text: { tag: "plain_text", content: "Confirm" },
      type: "primary",
      action_type: "form_submit",
      value: callbackValue("confirm"),
    }),
    component({
      tag: "button",
      name: "request_revision",
      text: { tag: "plain_text", content: "Request revision" },
      type: "default",
      action_type: "form_submit",
      value: callbackValue("request_revision"),
    }),
    component({
      tag: "button",
      name: "reject",
      text: { tag: "plain_text", content: "Reject" },
      type: "danger",
      action_type: "form_submit",
      value: callbackValue("reject"),
      confirm: {
        title: { tag: "plain_text", content: "Reject draft" },
        text: { tag: "plain_text", content: "Confirm the rejection after selecting the checkbox." },
      },
    }),
  ];
  const metadata = [
    `Risk: ${revision.riskLevel}`,
    `Revision: ${input.presentation.revisionNumber}`,
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
