import { KNOWLEDGE_DRAFT_REFERENCE_MAX_CHARS } from "../knowledge-governance/knowledge-draft.js";

export const KNOWLEDGE_CARD_ACTIONS = ["confirm", "request_revision", "reject"] as const;
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
export type KnowledgeCardPresentationState = (typeof KNOWLEDGE_CARD_PRESENTATION_STATES)[number];

export type ApprovalInteractionJob = {
  idempotencyKey: string;
  eventId: string;
  appId: string;
  actorOpenId: string;
  chatId: string;
  messageId?: string;
  presentationId: string;
  draftId: string;
  revisionNumber: number;
  draftVersion: number;
  action: "confirm" | "request_revision" | "reject";
  reason?: string;
  rejectionConfirmed?: true;
  receivedAt: Date;
  attempts: number;
};

export class KnowledgeCardValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KnowledgeCardValidationError";
  }
}

export function normalizeApprovalInteractionJob(input: unknown): ApprovalInteractionJob {
  if (!isRecord(input)) throw validationError("approval interaction job must be an object");
  assertKnownFields(input, [
    "idempotencyKey",
    "eventId",
    "appId",
    "actorOpenId",
    "chatId",
    "messageId",
    "presentationId",
    "draftId",
    "revisionNumber",
    "draftVersion",
    "action",
    "reason",
    "rejectionConfirmed",
    "receivedAt",
    "attempts",
  ]);

  const action = requireAction(input.action);
  const reason = normalizeReason(input.reason, action);
  const rejectionConfirmed = normalizeRejectionConfirmed(input.rejectionConfirmed, action);

  return {
    idempotencyKey: requireReference("idempotencyKey", input.idempotencyKey),
    eventId: requireReference("eventId", input.eventId),
    appId: requireReference("appId", input.appId),
    actorOpenId: requireReference("actorOpenId", input.actorOpenId),
    chatId: requireReference("chatId", input.chatId),
    ...(input.messageId === undefined
      ? {}
      : { messageId: requireReference("messageId", input.messageId) }),
    presentationId: requireReference("presentationId", input.presentationId),
    draftId: requireReference("draftId", input.draftId),
    revisionNumber: requirePositiveInteger("revisionNumber", input.revisionNumber),
    draftVersion: requirePositiveInteger("draftVersion", input.draftVersion),
    action,
    ...(reason === undefined ? {} : { reason }),
    ...(rejectionConfirmed === undefined ? {} : { rejectionConfirmed }),
    receivedAt: requireDate("receivedAt", input.receivedAt),
    attempts: requireNonnegativeInteger("attempts", input.attempts),
  };
}

function assertKnownFields(value: Record<string, unknown>, allowedFields: string[]): void {
  for (const field of Object.keys(value)) {
    if (!allowedFields.includes(field)) throw validationError(`unknown approval interaction field: ${field}`);
  }
}

function requireAction(value: unknown): KnowledgeCardAction {
  if (!KNOWLEDGE_CARD_ACTIONS.includes(value as KnowledgeCardAction)) {
    throw validationError("action is invalid");
  }
  return value as KnowledgeCardAction;
}

function normalizeReason(value: unknown, action: KnowledgeCardAction): string | undefined {
  if (action === "confirm") return undefined;
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
  action: KnowledgeCardAction,
): true | undefined {
  if (action !== "reject") return undefined;
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
