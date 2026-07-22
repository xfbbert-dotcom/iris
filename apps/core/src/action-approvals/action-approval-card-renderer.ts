import {
  KNOWLEDGE_CARD_JSON_MAX_BYTES,
  KNOWLEDGE_CARD_MAX_COMPONENTS,
  KNOWLEDGE_CARD_REASON_MAX_CHARS,
  type ActionProposalCardAction,
} from "../knowledge-cards/knowledge-card.js";

import type {
  ActionApprovalPresentation,
  ActionApprovalRequirement,
  ActionProposalContext,
  PublicationTargetPolicy,
} from "./action-proposal-repository.js";

const FEISHU_INPUT_MAX_LENGTH = 1_000;

export type ActionApprovalCardRenderInput = {
  context: ActionProposalContext;
  requirement: ActionApprovalRequirement;
  policy: PublicationTargetPolicy;
  presentation: ActionApprovalPresentation;
  reviewPublicOrigin?: string;
};

export type ActionApprovalCardRenderResult = {
  card: Record<string, unknown>;
  json: string;
  componentCount: number;
};

export class ActionApprovalCardBindingError extends Error {
  constructor() {
    super("action approval card facts do not match");
    this.name = "ActionApprovalCardBindingError";
  }
}

export function renderActionApprovalCard(
  input: ActionApprovalCardRenderInput,
): ActionApprovalCardRenderResult {
  assertExactBinding(input);
  let componentCount = 0;
  const component = <T extends Record<string, unknown>>(value: T): T => {
    componentCount += 1;
    return value;
  };
  const { proposal } = input.context;
  const callbackValue = (action: ActionProposalCardAction) => ({
    kind: "action_proposal_approval",
    action,
    presentationId: input.presentation.id,
    proposalId: proposal.id,
    requirementId: input.requirement.id,
    proposalVersion: String(proposal.version),
    subjectRevision: String(proposal.subjectRevision),
    subjectVersion: String(proposal.subjectVersion),
    targetPolicyVersion: String(proposal.targetPolicyVersion),
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
      placeholder: {
        tag: "plain_text",
        content: "Describe the required change or rejection reason",
      },
    }),
    component({
      tag: "button",
      name: "approve",
      text: { tag: "plain_text", content: "Approve" },
      type: "primary",
      form_action_type: "submit",
      behaviors: [{ type: "callback", value: callbackValue("approve") }],
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
        title: { tag: "plain_text", content: "Reject publication" },
        text: {
          tag: "plain_text",
          content: "Confirm this rejection. The submitted reason will be recorded.",
        },
      },
    }),
  ];
  const metadata = [
    "Iris / publication_approval",
    "Action: publish_knowledge_draft",
    `Risk: ${proposal.riskLevel}`,
    `Target: ${requireDisplayName(input.policy.displayName)}`,
    `Draft revision: ${proposal.subjectRevision}`,
    `Proposal version: ${proposal.version}`,
  ].join("\n");
  const requirementSummary = input.context.requirements
    .map((requirement) => `${requirement.kind}: ${requirement.state}`)
    .join("\n");
  const bodyElements: Record<string, unknown>[] = [
    component({ tag: "markdown", content: metadata }),
    component({ tag: "markdown", content: requirementSummary }),
  ];
  const reviewUrl = buildReviewUrl(input.reviewPublicOrigin, proposal.id);
  if (reviewUrl !== undefined) {
    bodyElements.push(component({
      tag: "markdown",
      content: `[View full draft](${reviewUrl})`,
    }));
  }
  bodyElements.push(component({
    tag: "form",
    name: "actionProposalReview",
    elements: formElements,
  }));
  if (componentCount > KNOWLEDGE_CARD_MAX_COMPONENTS) {
    throw new Error("action approval card has too many components");
  }
  const card: Record<string, unknown> = {
    schema: "2.0",
    header: {
      template: proposal.riskLevel === "high" ? "red" : "orange",
      title: { tag: "plain_text", content: "Approve knowledge publication" },
    },
    body: { elements: bodyElements },
  };
  const json = JSON.stringify(card);
  if (Buffer.byteLength(json, "utf8") > KNOWLEDGE_CARD_JSON_MAX_BYTES) {
    throw new Error("action approval card is too large");
  }
  return { card, json, componentCount };
}

function assertExactBinding(input: ActionApprovalCardRenderInput): void {
  const { proposal, requirements } = input.context;
  const requirement = requirements.find((item) => item.id === input.requirement.id);
  if (
    proposal.status !== "pending_approval" ||
    input.presentation.state !== "pending_send" ||
    input.presentation.proposalId !== proposal.id ||
    input.presentation.requirementId !== input.requirement.id ||
    input.presentation.proposalVersion !== proposal.version ||
    requirement === undefined ||
    requirement !== input.requirement ||
    input.requirement.proposalId !== proposal.id ||
    input.requirement.state !== "pending" ||
    !isPresentationRecipientBound(input.requirement, input.presentation.recipientOpenId) ||
    input.requirement.targetPolicyId !== proposal.targetPolicyId ||
    input.requirement.targetPolicyVersion !== proposal.targetPolicyVersion ||
    input.policy.id !== proposal.targetPolicyId ||
    input.policy.version !== proposal.targetPolicyVersion ||
    !input.policy.enabled
  ) {
    throw new ActionApprovalCardBindingError();
  }
}

function isPresentationRecipientBound(
  requirement: ActionApprovalRequirement,
  recipientOpenId: string,
): boolean {
  if (requirement.kind === "designated_owner") {
    return requirement.roleRefType === "feishu_user" && requirement.roleRef === recipientOpenId;
  }
  return requirement.kind === "iris_admin_or_authorized_owner";
}

function buildReviewUrl(origin: string | undefined, proposalId: string): string | undefined {
  if (origin === undefined) return undefined;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new ActionApprovalCardBindingError();
  }
  if (
    !(url.protocol === "https:" || url.protocol === "http:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new ActionApprovalCardBindingError();
  }
  return `${url.origin}/review/action-proposals/${encodeURIComponent(proposalId)}`;
}

function requireDisplayName(value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || [...normalized].length > 512) {
    throw new ActionApprovalCardBindingError();
  }
  return normalized;
}
