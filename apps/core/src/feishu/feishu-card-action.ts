import {
  ACTION_PROPOSAL_CARD_ACTIONS,
  KNOWLEDGE_CARD_ACTIONS,
  KNOWLEDGE_CARD_REASON_MAX_CHARS,
  PROACTIVE_SIGNAL_FEEDBACK_ACTIONS,
  type ActionProposalCardAction,
  type KnowledgeCardAction,
  type ProactiveSignalFeedbackAction,
} from "../knowledge-cards/knowledge-card.js";
import { KNOWLEDGE_DRAFT_REFERENCE_MAX_CHARS } from "../knowledge-governance/knowledge-draft.js";

const FEISHU_CARD_ACTION_EVENT_TYPE = "card.action.trigger";

type ParsedFeishuCardActionCommon = {
  eventId: string;
  appId: string;
  actorOpenId: string;
  chatId: string;
  messageId?: string;
  presentationId: string;
  reason?: string;
  rejectionConfirmed?: true;
};

type ParsedKnowledgeActionPayload = {
  kind: "knowledge_draft_confirmation";
  presentationId: string;
  draftId: string;
  revisionNumber: number;
  draftVersion: number;
  action: KnowledgeCardAction;
  reason?: string;
  rejectionConfirmed?: true;
};

type ParsedActionProposalPayload = {
  kind: "action_proposal_approval";
  presentationId: string;
  proposalId: string;
  requirementId: string;
  proposalVersion: number;
  subjectRevision: number;
  subjectVersion: number;
  targetPolicyVersion: number;
  action: ActionProposalCardAction;
  reason?: string;
  rejectionConfirmed?: true;
};

type ParsedProactiveSignalFeedbackPayload = {
  kind: "proactive_signal_feedback";
  deliveryId: string;
  candidateIdempotencyKey: string;
  entityVersion: number;
  action: ProactiveSignalFeedbackAction;
};

type ParsedActionPayload =
  | ParsedKnowledgeActionPayload
  | ParsedActionProposalPayload
  | ParsedProactiveSignalFeedbackPayload;
type ParsedCallbackValue =
  | Omit<ParsedKnowledgeActionPayload, "reason" | "rejectionConfirmed">
  | Omit<ParsedActionProposalPayload, "reason" | "rejectionConfirmed">
  | ParsedProactiveSignalFeedbackPayload;

export type ParsedFeishuCardAction = ParsedFeishuCardActionCommon & ParsedActionPayload;

export function parseFeishuCardAction(body: unknown): ParsedFeishuCardAction | undefined {
  if (!isRecord(body) || !hasOnlyKeys(body, ["schema", "header", "event"]) || body.schema !== "2.0") {
    return undefined;
  }

  const header = parseHeader(body.header);
  const event = parseEvent(body.event);
  if (header === undefined || event === undefined) return undefined;
  return { ...header, ...event } as ParsedFeishuCardAction;
}

function parseHeader(value: unknown): { eventId: string; appId: string } | undefined {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["event_id", "token", "create_time", "event_type", "tenant_key", "app_id"]) ||
    value.event_type !== FEISHU_CARD_ACTION_EVENT_TYPE
  ) {
    return undefined;
  }

  const eventId = parseReference(value.event_id);
  const appId = parseReference(value.app_id);
  if (eventId === undefined || appId === undefined || !areOptionalStrings(value, ["token", "create_time", "tenant_key"])) {
    return undefined;
  }
  return { eventId, appId };
}

function parseEvent(value: unknown): Omit<ParsedFeishuCardAction, "eventId" | "appId"> | undefined {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["operator", "token", "action", "host", "context"]) ||
    value.host !== "im_message" ||
    !areOptionalStrings(value, ["token"])
  ) {
    return undefined;
  }

  const actorOpenId = parseOperator(value.operator);
  const context = parseContext(value.context);
  const action = parseAction(value.action);
  if (actorOpenId === undefined || context === undefined || action === undefined) return undefined;
  return {
    actorOpenId,
    chatId: context.chatId,
    ...(context.messageId === undefined ? {} : { messageId: context.messageId }),
    ...action,
  } as Omit<ParsedFeishuCardAction, "eventId" | "appId">;
}

function parseOperator(value: unknown): string | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ["tenant_key", "user_id", "open_id", "union_id"])) {
    return undefined;
  }
  return areOptionalStrings(value, ["tenant_key", "user_id", "union_id"])
    ? parseReference(value.open_id)
    : undefined;
}

function parseContext(value: unknown): { chatId: string; messageId?: string } | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ["open_message_id", "open_chat_id"])) return undefined;
  const chatId = parseReference(value.open_chat_id);
  const messageId = value.open_message_id === undefined ? undefined : parseReference(value.open_message_id);
  if (chatId === undefined || (value.open_message_id !== undefined && messageId === undefined)) return undefined;
  return { chatId, ...(messageId === undefined ? {} : { messageId }) };
}

function parseAction(value: unknown): ParsedActionPayload | undefined {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["value", "tag", "name", "timezone", "form_value"]) ||
    value.tag !== "button" ||
    !areOptionalStrings(value, ["timezone"])
  ) {
    return undefined;
  }

  const callbackValue = parseCallbackValue(value.value);
  if (callbackValue === undefined || value.name !== callbackValue.action) {
    return undefined;
  }
  if (callbackValue.kind === "proactive_signal_feedback") {
    return isEmptyFormValue(value.form_value) ? callbackValue : undefined;
  }

  const formValue = parseFormValue(value.form_value);
  if (formValue === undefined) return undefined;

  if (callbackValue.action === "confirm" || callbackValue.action === "approve") {
    return formValue.reason === "" ? callbackValue : undefined;
  }
  if (callbackValue.action === "request_revision") {
    return formValue.reason === "" ? undefined : { ...callbackValue, reason: formValue.reason };
  }
  return formValue.reason === ""
    ? undefined
    : { ...callbackValue, reason: formValue.reason, rejectionConfirmed: true };
}

function parseCallbackValue(value: unknown): ParsedCallbackValue | undefined {
  if (!isRecord(value)) return undefined;
  if (value.kind === "knowledge_draft_confirmation") {
    return parseKnowledgeDraftCallbackValue(value);
  }
  if (value.kind === "action_proposal_approval") {
    return parseActionProposalCallbackValue(value);
  }
  if (value.kind === "proactive_signal_feedback") {
    return parseProactiveSignalFeedbackCallbackValue(value);
  }
  return undefined;
}

function parseKnowledgeDraftCallbackValue(value: Record<string, unknown>): ParsedCallbackValue | undefined {
  if (
    !hasOnlyKeys(value, ["kind", "action", "presentationId", "draftId", "revisionNumber", "draftVersion"]) ||
    !KNOWLEDGE_CARD_ACTIONS.includes(value.action as KnowledgeCardAction)
  ) {
    return undefined;
  }
  const presentationId = parseReference(value.presentationId);
  const draftId = parseReference(value.draftId);
  const revisionNumber = parsePositiveIntegerString(value.revisionNumber);
  const draftVersion = parsePositiveIntegerString(value.draftVersion);
  if (presentationId === undefined || draftId === undefined || revisionNumber === undefined || draftVersion === undefined) {
    return undefined;
  }
  return {
    kind: "knowledge_draft_confirmation",
    action: value.action as KnowledgeCardAction,
    presentationId,
    draftId,
    revisionNumber,
    draftVersion,
  };
}

function parseActionProposalCallbackValue(value: Record<string, unknown>): ParsedCallbackValue | undefined {
  if (
    !hasOnlyKeys(value, [
      "kind",
      "action",
      "presentationId",
      "proposalId",
      "requirementId",
      "proposalVersion",
      "subjectRevision",
      "subjectVersion",
      "targetPolicyVersion",
    ]) ||
    !ACTION_PROPOSAL_CARD_ACTIONS.includes(value.action as ActionProposalCardAction)
  ) {
    return undefined;
  }
  const presentationId = parseReference(value.presentationId);
  const proposalId = parseReference(value.proposalId);
  const requirementId = parseReference(value.requirementId);
  const proposalVersion = parsePositiveIntegerString(value.proposalVersion);
  const subjectRevision = parsePositiveIntegerString(value.subjectRevision);
  const subjectVersion = parsePositiveIntegerString(value.subjectVersion);
  const targetPolicyVersion = parsePositiveIntegerString(value.targetPolicyVersion);
  if (
    presentationId === undefined ||
    proposalId === undefined ||
    requirementId === undefined ||
    proposalVersion === undefined ||
    subjectRevision === undefined ||
    subjectVersion === undefined ||
    targetPolicyVersion === undefined
  ) {
    return undefined;
  }
  return {
    kind: "action_proposal_approval",
    action: value.action as ActionProposalCardAction,
    presentationId,
    proposalId,
    requirementId,
    proposalVersion,
    subjectRevision,
    subjectVersion,
    targetPolicyVersion,
  };
}

function parseProactiveSignalFeedbackCallbackValue(
  value: Record<string, unknown>,
): ParsedProactiveSignalFeedbackPayload | undefined {
  if (
    !hasOnlyKeys(value, ["kind", "action", "deliveryId", "candidateIdempotencyKey", "entityVersion"]) ||
    !PROACTIVE_SIGNAL_FEEDBACK_ACTIONS.includes(value.action as ProactiveSignalFeedbackAction)
  ) {
    return undefined;
  }
  const deliveryId = parseReference(value.deliveryId);
  const candidateIdempotencyKey = parseReference(value.candidateIdempotencyKey);
  const entityVersion = parsePositiveIntegerString(value.entityVersion);
  if (deliveryId === undefined || candidateIdempotencyKey === undefined || entityVersion === undefined) {
    return undefined;
  }
  return {
    kind: "proactive_signal_feedback",
    action: value.action as ProactiveSignalFeedbackAction,
    deliveryId,
    candidateIdempotencyKey,
    entityVersion,
  };
}

function parseFormValue(value: unknown): { reason: string } | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ["reason"]) || typeof value.reason !== "string") {
    return undefined;
  }
  const reason = value.reason.trim();
  return [...reason].length <= KNOWLEDGE_CARD_REASON_MAX_CHARS ? { reason } : undefined;
}

function isEmptyFormValue(value: unknown): boolean {
  return value === undefined || (isRecord(value) && Object.keys(value).length === 0);
}

function parseReference(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length >= 1 && normalized.length <= KNOWLEDGE_DRAFT_REFERENCE_MAX_CHARS
    ? normalized
    : undefined;
}

function parsePositiveIntegerString(value: unknown): number | undefined {
  if (typeof value !== "string" || !/^[1-9]\d*$/u.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function areOptionalStrings(value: Record<string, unknown>, keys: string[]): boolean {
  return keys.every((key) => value[key] === undefined || typeof value[key] === "string");
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
