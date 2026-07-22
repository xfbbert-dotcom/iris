import { KNOWLEDGE_DRAFT_REFERENCE_MAX_CHARS } from "../knowledge-governance/knowledge-draft.js";

export const KNOWLEDGE_CARD_ACTIONS = ["confirm", "request_revision", "reject"] as const;
export const ACTION_PROPOSAL_CARD_ACTIONS = ["approve", "request_revision", "reject"] as const;
export const APPROVAL_INTERACTION_KINDS = [
  "knowledge_draft_confirmation",
  "action_proposal_approval",
] as const;
export const KNOWLEDGE_CARD_PRESENTATION_STATES = [
  "pending_send",
  "active",
  "superseded",
  "closed",
  "send_failed",
] as const;
export const KNOWLEDGE_CARD_REASON_MAX_CHARS = 2_000;
export const KNOWLEDGE_CARD_BODY_MAX_CODE_POINTS = 8_000;
export const KNOWLEDGE_CARD_JSON_MAX_BYTES = 24 * 1024;
export const KNOWLEDGE_CARD_MAX_COMPONENTS = 100;

export type KnowledgeCardAction = (typeof KNOWLEDGE_CARD_ACTIONS)[number];
export type ActionProposalCardAction = (typeof ACTION_PROPOSAL_CARD_ACTIONS)[number];
export type ApprovalInteractionKind = (typeof APPROVAL_INTERACTION_KINDS)[number];
export type KnowledgeCardPresentationState = (typeof KNOWLEDGE_CARD_PRESENTATION_STATES)[number];

type ApprovalInteractionJobCommon = {
  idempotencyKey: string;
  eventId: string;
  appId: string;
  actorOpenId: string;
  chatId: string;
  messageId?: string;
  presentationId: string;
  reason?: string;
  rejectionConfirmed?: true;
  receivedAt: Date;
  attempts: number;
};

export type KnowledgeDraftConfirmationInteractionJob = ApprovalInteractionJobCommon & {
  kind: "knowledge_draft_confirmation";
  draftId: string;
  revisionNumber: number;
  draftVersion: number;
  action: KnowledgeCardAction;
};

export type ActionProposalApprovalInteractionJob = ApprovalInteractionJobCommon & {
  kind: "action_proposal_approval";
  proposalId: string;
  requirementId: string;
  proposalVersion: number;
  subjectRevision: number;
  subjectVersion: number;
  targetPolicyVersion: number;
  action: ActionProposalCardAction;
};

export type ApprovalInteractionJob =
  | KnowledgeDraftConfirmationInteractionJob
  | ActionProposalApprovalInteractionJob;

export class KnowledgeCardValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KnowledgeCardValidationError";
  }
}

export function normalizeApprovalInteractionJob(input: unknown): ApprovalInteractionJob {
  if (!isRecord(input)) throw validationError("approval interaction job must be an object");
  const kind = requireKind(input.kind);
  const commonFields = [
    "kind",
    "idempotencyKey",
    "eventId",
    "appId",
    "actorOpenId",
    "chatId",
    "messageId",
    "presentationId",
    "action",
    "reason",
    "rejectionConfirmed",
    "receivedAt",
    "attempts",
  ];
  assertKnownFields(input, kind === "knowledge_draft_confirmation"
    ? [...commonFields, "draftId", "revisionNumber", "draftVersion"]
    : [
        ...commonFields,
        "proposalId",
        "requirementId",
        "proposalVersion",
        "subjectRevision",
        "subjectVersion",
        "targetPolicyVersion",
      ]);

  const action = requireAction(input.action, kind);
  const reason = normalizeReason(input.reason, action);
  const rejectionConfirmed = normalizeRejectionConfirmed(input.rejectionConfirmed, action);
  const common = {
    kind,
    idempotencyKey: requireReference("idempotencyKey", input.idempotencyKey),
    eventId: requireReference("eventId", input.eventId),
    appId: requireReference("appId", input.appId),
    actorOpenId: requireReference("actorOpenId", input.actorOpenId),
    chatId: requireReference("chatId", input.chatId),
    ...(input.messageId === undefined
      ? {}
      : { messageId: requireReference("messageId", input.messageId) }),
    presentationId: requireReference("presentationId", input.presentationId),
    ...(reason === undefined ? {} : { reason }),
    ...(rejectionConfirmed === undefined ? {} : { rejectionConfirmed }),
    receivedAt: requireDate("receivedAt", input.receivedAt),
    attempts: requireNonnegativeInteger("attempts", input.attempts),
  };
  if (kind === "knowledge_draft_confirmation") {
    return {
      ...common,
      kind,
      draftId: requireReference("draftId", input.draftId),
      revisionNumber: requirePositiveInteger("revisionNumber", input.revisionNumber),
      draftVersion: requirePositiveInteger("draftVersion", input.draftVersion),
      action: action as KnowledgeCardAction,
    };
  }
  return {
    ...common,
    kind,
    proposalId: requireReference("proposalId", input.proposalId),
    requirementId: requireReference("requirementId", input.requirementId),
    proposalVersion: requirePositiveInteger("proposalVersion", input.proposalVersion),
    subjectRevision: requirePositiveInteger("subjectRevision", input.subjectRevision),
    subjectVersion: requirePositiveInteger("subjectVersion", input.subjectVersion),
    targetPolicyVersion: requirePositiveInteger("targetPolicyVersion", input.targetPolicyVersion),
    action: action as ActionProposalCardAction,
  };
}

function assertKnownFields(value: Record<string, unknown>, allowedFields: string[]): void {
  for (const field of Object.keys(value)) {
    if (!allowedFields.includes(field)) throw validationError(`unknown approval interaction field: ${field}`);
  }
}

function requireKind(value: unknown): ApprovalInteractionKind {
  if (!APPROVAL_INTERACTION_KINDS.includes(value as ApprovalInteractionKind)) {
    throw validationError("kind is invalid");
  }
  return value as ApprovalInteractionKind;
}

function requireAction(
  value: unknown,
  kind: ApprovalInteractionKind,
): KnowledgeCardAction | ActionProposalCardAction {
  const actions = kind === "knowledge_draft_confirmation"
    ? KNOWLEDGE_CARD_ACTIONS
    : ACTION_PROPOSAL_CARD_ACTIONS;
  if (!(actions as readonly unknown[]).includes(value)) {
    throw validationError("action is invalid");
  }
  return value as KnowledgeCardAction | ActionProposalCardAction;
}

function normalizeReason(
  value: unknown,
  action: KnowledgeCardAction | ActionProposalCardAction,
): string | undefined {
  if (action === "confirm" || action === "approve") {
    if (value !== undefined) throw validationError("reason is not allowed for this action");
    return undefined;
  }
  if (typeof value !== "string") throw validationError("reason must be a string");
  const normalized = value.trim();
  const codePointLength = [...normalized].length;
  if (codePointLength < 1 || codePointLength > KNOWLEDGE_CARD_REASON_MAX_CHARS) {
    throw validationError("reason length is invalid");
  }
  return normalized;
}

function normalizeRejectionConfirmed(
  value: unknown,
  action: KnowledgeCardAction | ActionProposalCardAction,
): true | undefined {
  if (action !== "reject") {
    if (value !== undefined) throw validationError("rejectionConfirmed is not allowed for this action");
    return undefined;
  }
  if (value !== true) throw validationError("rejectionConfirmed must be true");
  return true;
}

function requireReference(name: string, value: unknown): string {
  if (typeof value !== "string") throw validationError(`${name} must be a string`);
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > KNOWLEDGE_DRAFT_REFERENCE_MAX_CHARS) {
    throw validationError(`${name} length is invalid`);
  }
  return normalized;
}

function requirePositiveInteger(name: string, value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw validationError(`${name} must be a safe positive integer`);
  }
  return Number(value);
}

function requireNonnegativeInteger(name: string, value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw validationError(`${name} must be a safe nonnegative integer`);
  }
  return Number(value);
}

function requireDate(name: string, value: unknown): Date {
  if (value instanceof Date && Number.isFinite(value.getTime())) return new Date(value);
  if (typeof value === "string") {
    const parsed = new Date(value);
    if (Number.isFinite(parsed.getTime()) && parsed.toISOString() === value) return parsed;
  }
  throw validationError(`${name} must be a valid Date`);
}

function validationError(message: string): KnowledgeCardValidationError {
  return new KnowledgeCardValidationError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
