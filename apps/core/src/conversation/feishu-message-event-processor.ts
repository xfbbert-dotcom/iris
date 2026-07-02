import type {
  ConversationMessageRepository,
  UpsertConversationMessageInput,
} from "./conversation-message-repository.js";
import type { RawEvent } from "../events/raw-event-queue.js";

export function createFeishuMessageEventProcessor({
  messages,
}: {
  messages: Pick<ConversationMessageRepository, "upsertMessage">;
}) {
  return {
    async process(event: RawEvent): Promise<void> {
      const parsed = parseFeishuMessageEvent(event);
      if (parsed === undefined) {
        return;
      }

      await messages.upsertMessage(parsed);
    },
  };
}

function parseFeishuMessageEvent(event: RawEvent): UpsertConversationMessageInput | undefined {
  if (event.provider !== "feishu" || !isRecord(event.rawBody)) {
    return undefined;
  }

  const header = event.rawBody.header;
  const eventType = isRecord(header) ? readString(header.event_type) : event.eventType;
  if (eventType !== "im.message.receive_v1") {
    return undefined;
  }

  const eventBody = event.rawBody.event;
  if (!isRecord(eventBody) || !isRecord(eventBody.message)) {
    return undefined;
  }

  const message = eventBody.message;
  const providerMessageId = readString(message.message_id);
  const chatId = readString(message.chat_id);
  const messageType = readString(message.message_type);
  if (providerMessageId.length === 0 || chatId.length === 0 || messageType.length === 0) {
    return undefined;
  }

  return {
    provider: "feishu",
    providerMessageId,
    chatId,
    senderId: readSenderId(eventBody.sender),
    messageType,
    text: readText(messageType, message.content),
    sentAt: readFeishuTimestamp(message.create_time, event.receivedAt),
    rawEventIdempotencyKey: event.idempotencyKey,
  };
}

function readSenderId(sender: unknown): string | undefined {
  if (!isRecord(sender) || !isRecord(sender.sender_id)) {
    return undefined;
  }

  return (
    readOptionalString(sender.sender_id.open_id) ??
    readOptionalString(sender.sender_id.union_id) ??
    readOptionalString(sender.sender_id.user_id)
  );
}

function readText(messageType: string, content: unknown): string | undefined {
  if (messageType !== "text" || typeof content !== "string") {
    return undefined;
  }

  try {
    const parsed = JSON.parse(content) as unknown;
    if (!isRecord(parsed)) {
      return undefined;
    }

    return readOptionalString(parsed.text);
  } catch {
    return undefined;
  }
}

function readFeishuTimestamp(value: unknown, fallback: Date): Date {
  const parsed =
    typeof value === "string" && value.trim().length > 0 ? Number(value.trim()) : undefined;
  if (parsed === undefined || !Number.isFinite(parsed)) {
    return fallback;
  }

  const date = new Date(parsed);
  return Number.isNaN(date.getTime()) ? fallback : date;
}

function readString(value: unknown): string {
  return readOptionalString(value) ?? "";
}

function readOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
