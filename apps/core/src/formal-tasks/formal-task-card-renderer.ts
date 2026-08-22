import { createHash } from "node:crypto";

import {
  KNOWLEDGE_CARD_BODY_MAX_CODE_POINTS,
  KNOWLEDGE_CARD_JSON_MAX_BYTES,
  KNOWLEDGE_CARD_MAX_COMPONENTS,
  KNOWLEDGE_CARD_REASON_MAX_CHARS,
  type KnowledgeCardAction,
} from "../knowledge-cards/knowledge-card.js";

import type { FormalTaskDraftView } from "./formal-task-repository.js";
import type {
  FormalTaskCardCommittedResult,
  FormalTaskDraftPresentation,
} from "./formal-task-card-repository.js";

const FEISHU_INPUT_MAX_LENGTH = 1_000;

export type FormalTaskDraftCardRenderResult =
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

export class FormalTaskCardPresentationBindingError extends Error {
  constructor() {
    super("formal task card presentation does not match draft");
    this.name = "FormalTaskCardPresentationBindingError";
  }
}

export function renderFormalTaskDraftCard(input: {
  draft: FormalTaskDraftView;
  presentation: FormalTaskDraftPresentation;
  targetDisplayName: string;
}): FormalTaskDraftCardRenderResult {
  const revision = input.draft.currentRevision;
  if (!("taskSpec" in revision)) throw new FormalTaskCardPresentationBindingError();
  const taskSpec = revision.taskSpec;
  if (
    input.presentation.draftId !== input.draft.id ||
    input.presentation.draftRevision !== input.draft.currentRevisionNumber ||
    input.presentation.draftVersion !== input.draft.version ||
    input.presentation.taskSpecHash !== input.draft.currentTaskSpecHash ||
    input.presentation.taskSpecHash !== revision.taskSpecHash ||
    input.presentation.groupId !== input.draft.sourceGroupId ||
    taskSpec.sourceGroupId !== input.draft.sourceGroupId
  ) throw new FormalTaskCardPresentationBindingError();
  if ([...taskSpec.description].length > KNOWLEDGE_CARD_BODY_MAX_CODE_POINTS) {
    return { status: "review_required", reason: "body_too_large" };
  }

  let componentCount = 0;
  const component = <T extends Record<string, unknown>>(value: T): T => {
    componentCount += 1;
    return value;
  };
  const callbackValue = (action: KnowledgeCardAction) => ({
    kind: "formal_task_draft_confirmation",
    action,
    presentationId: input.presentation.id,
    draftId: input.draft.id,
    revisionNumber: String(input.presentation.draftRevision),
    draftVersion: String(input.presentation.draftVersion),
    taskSpecHash: input.presentation.taskSpecHash,
    targetPolicyId: taskSpec.targetPolicyId,
    targetPolicyVersion: String(taskSpec.targetPolicyVersion),
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
      text: { tag: "plain_text", content: "Confirm exact task draft" },
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
        title: { tag: "plain_text", content: "Reject task draft" },
        text: {
          tag: "plain_text",
          content: "Confirm this irreversible rejection. The submitted reason will be recorded.",
        },
      },
    }),
  ];
  const due = taskSpec.dueAtUtc ?? "none";
  const reminder = taskSpec.reminderMinutes === undefined
    ? "none"
    : `${taskSpec.reminderMinutes} minutes before due time`;
  const metadata = [
    `Iris / ${input.draft.status}`,
    `Draft ID: ${input.draft.id}`,
    `Draft revision: ${input.presentation.draftRevision}`,
    `Draft version: ${input.presentation.draftVersion}`,
    `Risk: ${revision.riskLevel}`,
    `Assignee: <at id=${taskSpec.assigneeOpenId}></at>`,
    `Due: ${due}`,
    `Reminder: ${reminder}`,
    `Evidence items: ${revision.evidence.length}`,
    `Target: ${requireBoundedText("targetDisplayName", input.targetDisplayName, 256)}`,
    `Task-spec fingerprint: ${input.presentation.taskSpecHash.slice(0, 12)}`,
  ].join("\n");
  const bodyElements: Record<string, unknown>[] = [
    component({ tag: "markdown", content: metadata }),
    component({ tag: "markdown", content: taskSpec.description }),
    component({ tag: "form", name: "formalTaskDraftReview", elements: formElements }),
  ];
  if (componentCount > KNOWLEDGE_CARD_MAX_COMPONENTS) {
    return { status: "review_required", reason: "too_many_components" };
  }
  const card: Record<string, unknown> = {
    schema: "2.0",
    header: {
      template: "blue",
      title: { tag: "plain_text", content: taskSpec.title },
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

export function renderFormalTaskCardCommittedResult(input: {
  draft: FormalTaskDraftView;
  presentation: FormalTaskDraftPresentation;
  result: FormalTaskCardCommittedResult;
}): string {
  if (
    input.presentation.state !== "closed" ||
    input.presentation.draftId !== input.draft.id ||
    input.presentation.draftRevision !== input.draft.currentRevisionNumber ||
    input.presentation.taskSpecHash !== input.draft.currentTaskSpecHash
  ) throw new FormalTaskCardPresentationBindingError();

  let title: string;
  let template: "green" | "orange" | "red";
  let outcome: string[];
  if (input.result.action === "confirm") {
    title = "Formal task draft confirmed";
    template = "green";
    outcome = [
      "Result: confirmed",
      `Confirmed by: ${requireBoundedText("actorOpenId", input.result.actorOpenId, 512)}`,
      `Confirmed at: ${requireDate(input.result.confirmedAt).toISOString()}`,
      `Next gate: ${input.result.nextGate}`,
      "No Feishu task has been created yet.",
    ];
  } else if (input.result.action === "request_revision") {
    title = "Formal task draft revision requested";
    template = "orange";
    outcome = [
      "Result: revision_requested",
      `State: ${input.result.state}`,
      `Reason: ${requireBoundedText("reason", input.result.reason, KNOWLEDGE_CARD_REASON_MAX_CHARS)}`,
    ];
  } else {
    title = "Formal task draft rejected";
    template = "red";
    outcome = [
      "Result: rejected",
      `State: ${input.result.state}`,
      `Reason: ${requireBoundedText("reason", input.result.reason, KNOWLEDGE_CARD_REASON_MAX_CHARS)}`,
    ];
  }
  const json = JSON.stringify({
    schema: "2.0",
    header: { template, title: { tag: "plain_text", content: title } },
    body: {
      elements: [{
        tag: "markdown",
        content: [
          `Draft ID: ${input.presentation.draftId}`,
          `Draft revision: ${input.presentation.draftRevision}`,
          `Draft version: ${input.presentation.draftVersion}`,
          `Task-spec fingerprint: ${input.presentation.taskSpecHash.slice(0, 12)}`,
          ...outcome,
        ].join("\n"),
      }],
    },
  });
  if (Buffer.byteLength(json, "utf8") > KNOWLEDGE_CARD_JSON_MAX_BYTES) {
    throw new Error("formal task card committed result is too large");
  }
  return json;
}

function requireBoundedText(name: string, value: string, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    [...value].length > maximum ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) throw new Error(`formal task card ${name} is invalid`);
  return value;
}

function requireDate(value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error("formal task card date is invalid");
  }
  return new Date(value);
}
