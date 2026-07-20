import {
  KNOWLEDGE_CARD_ACTIONS,
  KNOWLEDGE_CARD_REASON_MAX_CHARS,
  type KnowledgeCardAction,
} from "../knowledge-cards/knowledge-card.js";
import { KNOWLEDGE_DRAFT_REFERENCE_MAX_CHARS } from "../knowledge-governance/knowledge-draft.js";

const FEISHU_CARD_ACTION_EVENT_TYPE = "card.action.trigger";

export type ParsedFeishuCardAction = {
  eventId: string;
  appId: string;
  actorOpenId: string;
  chatId: string;
  messageId?: string;
  presentationId: string;
  draftId: string;
  revisionNumber: number;
  draftVersion: number;
  action: KnowledgeCardAction;
  reason?: string;
  rejectionConfirmed?: true;
};

export function parseFeishuCardAction(body: unknown): ParsedFeishuCardAction | undefined {
  if (!isRecord(body) || !hasOnlyKeys(body, ["schema", "header", "event"]) || body.schema !== "2.0") {
    return undefined;
  }

  const header = parseHeader(body.header);
  const event = parseEvent(body.event);
  if (header === undefined || event === undefined) {
    return undefined;
  }

  return {
    eventId: header.eventId,
    appId: header.appId,
    actorOpenId: event.actorOpenId,
    chatId: event.chatId,
    ...(event.messageId === undefined ? {} : { messageId: event.messageId }),
    presentationId: event.presentationId,
    draftId: event.draftId,
    revisionNumber: event.revisionNumber,
    draftVersion: event.draftVersion,
    action: event.action,
    ...(event.reason === undefined ? {} : { reason: event.reason }),
    ...(event.rejectionConfirmed === undefined ? {} : { rejectionConfirmed: event.rejectionConfirmed }),
  };
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
  if (actorOpenId === undefined || context === undefined || action === undefined) {
    return undefined;
  }

  return {
    actorOpenId,
    chatId: context.chatId,
    ...(context.messageId === undefined ? {} : { messageId: context.messageId }),
    ...action,
  };
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
  if (!isRecord(value) || !hasOnlyKeys(value, ["open_message_id", "open_chat_id"])) {
    return undefined;
  }

  const chatId = parseReference(value.open_chat_id);
  const messageId = value.open_message_id === undefined ? undefined : parseReference(value.open_message_id);
  if (chatId === undefined || (value.open_message_id !== undefined && messageId === undefined)) {
    return undefined;
  }

  return { chatId, ...(messageId === undefined ? {} : { messageId }) };
}

function parseAction(value: unknown): Omit<ParsedFeishuCardAction, "eventId" | "appId" | "actorOpenId" | "chatId" | "messageId"> | undefined {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["value", "tag", "name", "timezone", "form_value"]) ||
    value.tag !== "button" ||
    !areOptionalStrings(value, ["timezone"])
  ) {
    return undefined;
  }

  const callbackValue = parseCallbackValue(value.value);
  const formValue = parseFormValue(value.form_value);
  if (callbackValue === undefined || formValue === undefined || value.name !== callbackValue.action) {
    return undefined;
  }

  if (callbackValue.action === "confirm") {
    return formValue.reason === "" ? callbackValue : undefined;
  }
  if (callbackValue.action === "request_revision") {
    return formValue.reason !== ""
      ? { ...callbackValue, reason: formValue.reason }
      : undefined;
  }

  return formValue.reason !== ""
    ? { ...callbackValue, reason: formValue.reason, rejectionConfirmed: true }
    : undefined;
}

function parseCallbackValue(value: unknown): Pick<ParsedFeishuCardAction, "presentationId" | "draftId" | "revisionNumber" | "draftVersion" | "action"> | undefined {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["action", "presentationId", "draftId", "revisionNumber", "draftVersion"]) ||
    !KNOWLEDGE_CARD_ACTIONS.includes(value.action as KnowledgeCardAction)
  ) {
    return undefined;
  }

  const presentationId = parseReference(value.presentationId);
  const draftId = parseReference(value.draftId);
  if (
    presentationId === undefined ||
    draftId === undefined ||
    !isPositiveInteger(value.revisionNumber) ||
    !isPositiveInteger(value.draftVersion)
  ) {
    return undefined;
  }

  return {
    action: value.action as KnowledgeCardAction,
    presentationId,
    draftId,
    revisionNumber: value.revisionNumber,
    draftVersion: value.draftVersion,
  };
}

function parseFormValue(value: unknown): { reason: string } | undefined {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["reason"]) ||
    typeof value.reason !== "string"
  ) {
    return undefined;
  }

  const reason = value.reason.trim();
  if ([...reason].length > KNOWLEDGE_CARD_REASON_MAX_CHARS) {
    return undefined;
  }

  return { reason };
}

function parseReference(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length >= 1 && normalized.length <= KNOWLEDGE_DRAFT_REFERENCE_MAX_CHARS
    ? normalized
    : undefined;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
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
