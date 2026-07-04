import { createFeishuDocumentLinkExtractor } from "../documents/feishu-document-link-extractor.js";

export type IrisNormalizedEvent = IrisGroupMessageEvent | IrisUnsupportedEvent;

export type IrisGroupMessageEvent = {
  kind: "group_message";
  eventId: string;
  messageId: string;
  chatId: string;
  senderOpenId: string;
  messageType: "text";
  text: string;
  timestamp: Date;
  documentLinks: string[];
};

export type IrisUnsupportedEvent = {
  kind: "unsupported";
  eventId: string;
  reason: "missing_message" | "missing_required_fields" | "unsupported_message_type";
};

const feishuDocumentLinkExtractor = createFeishuDocumentLinkExtractor();
const MAX_FEISHU_IDENTIFIER_CHARS = 512;

export function normalizeFeishuEvent(payload: unknown): IrisNormalizedEvent {
  const eventId = readBoundedString(payload, "event_id") ?? "unknown";
  const event = readObject(payload, "event");
  const message = readObject(event, "message");

  if (message === undefined) {
    return {
      kind: "unsupported",
      eventId,
      reason: "missing_message"
    };
  }

  const sender = readObject(event, "sender");
  const senderId = readObject(sender, "sender_id");
  const senderOpenId = readBoundedString(senderId, "open_id");
  const messageId = readBoundedString(message, "message_id");
  const chatId = readBoundedString(message, "chat_id");
  const createTime = readString(message, "create_time");
  const messageType = readString(message, "message_type");
  const content = readString(message, "content");

  if (
    messageId === undefined ||
    chatId === undefined ||
    senderOpenId === undefined ||
    createTime === undefined ||
    messageType === undefined ||
    content === undefined
  ) {
    return {
      kind: "unsupported",
      eventId,
      reason: "missing_required_fields"
    };
  }

  if (messageType !== "text") {
    return {
      kind: "unsupported",
      eventId,
      reason: "unsupported_message_type"
    };
  }

  const timestampMs = readFeishuTimestampMillis(createTime);
  if (timestampMs === undefined) {
    return {
      kind: "unsupported",
      eventId,
      reason: "missing_required_fields"
    };
  }
  const timestamp = new Date(timestampMs);
  if (!Number.isFinite(timestamp.getTime())) {
    return {
      kind: "unsupported",
      eventId,
      reason: "missing_required_fields"
    };
  }

  const text = parseTextContent(content);

  return {
    kind: "group_message",
    eventId,
    messageId,
    chatId,
    senderOpenId,
    messageType,
    text,
    timestamp,
    documentLinks: extractFeishuDocumentLinks(text)
  };
}

function parseTextContent(content: string): string {
  try {
    const parsed: unknown = JSON.parse(content);
    const text = readString(parsed, "text");
    return text ?? content;
  } catch {
    return content;
  }
}

function readFeishuTimestampMillis(value: string): number | undefined {
  const trimmed = value.trim();
  if (!/^\d+$/u.test(trimmed)) {
    return undefined;
  }

  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    return undefined;
  }

  return parsed;
}

function extractFeishuDocumentLinks(text: string): string[] {
  return feishuDocumentLinkExtractor.extractLinks(text).map((link) => link.sourceUri);
}

function readObject(source: unknown, key: string): Record<string, unknown> | undefined {
  const value = readValue(source, key);
  return isRecord(value) ? value : undefined;
}

function readString(source: unknown, key: string): string | undefined {
  const value = readValue(source, key);
  return typeof value === "string" ? value : undefined;
}

function readBoundedString(source: unknown, key: string): string | undefined {
  const value = readString(source, key);
  if (value === undefined || value.length > MAX_FEISHU_IDENTIFIER_CHARS) {
    return undefined;
  }

  return value;
}

function readValue(source: unknown, key: string): unknown {
  if (!isRecord(source)) {
    return undefined;
  }

  return source[key];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
