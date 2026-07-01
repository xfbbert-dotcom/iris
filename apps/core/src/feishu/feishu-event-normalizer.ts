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

export function normalizeFeishuEvent(payload: unknown): IrisNormalizedEvent {
  const eventId = readString(payload, "event_id") ?? "unknown";
  const event = readObject(payload, "event");
  const message = readObject(event, "message");

  if (message === undefined) {
    return {
      kind: "unsupported",
      eventId,
      reason: "missing_message"
    };
  }

  const messageType = readString(message, "message_type");
  if (messageType !== "text") {
    return {
      kind: "unsupported",
      eventId,
      reason: "unsupported_message_type"
    };
  }

  const sender = readObject(event, "sender");
  const senderId = readObject(sender, "sender_id");
  const senderOpenId = readString(senderId, "open_id");
  const messageId = readString(message, "message_id");
  const chatId = readString(message, "chat_id");
  const createTime = readString(message, "create_time");
  const content = readString(message, "content");

  if (
    messageId === undefined ||
    chatId === undefined ||
    senderOpenId === undefined ||
    createTime === undefined ||
    content === undefined
  ) {
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
    timestamp: new Date(Number(createTime)),
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

function extractFeishuDocumentLinks(text: string): string[] {
  const links = text.match(/https:\/\/[^\s"'<>]+\.feishu\.cn\/(?:docx|wiki|file|docs)\/[^\s"'<>]+/g);
  return links?.map(trimTrailingPunctuation) ?? [];
}

function trimTrailingPunctuation(value: string): string {
  return value.replace(/[),.;:!?]+$/u, "");
}

function readObject(source: unknown, key: string): Record<string, unknown> | undefined {
  const value = readValue(source, key);
  return isRecord(value) ? value : undefined;
}

function readString(source: unknown, key: string): string | undefined {
  const value = readValue(source, key);
  return typeof value === "string" ? value : undefined;
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
