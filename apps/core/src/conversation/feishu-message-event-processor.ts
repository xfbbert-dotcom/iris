import type {
  ConversationMessageRepository,
  UpsertConversationMessageInput,
} from "./conversation-message-repository.js";
import type { RawEvent } from "../events/raw-event-queue.js";
import type {
  FeishuDocumentLink,
  FeishuDocumentLinkExtractor,
} from "../documents/feishu-document-link-extractor.js";
import type { GroupVisibleDocumentRegistrar } from "../documents/group-visible-document-registrar.js";

type RuntimeGate = {
  canProcessIncomingEvent(input: { groupId?: string }): boolean;
};

export function createFeishuMessageEventProcessor({
  messages,
  documentLinkExtractor,
  groupVisibleDocumentRegistrar,
  runtimeController,
}: {
  messages: Pick<ConversationMessageRepository, "upsertMessage">;
  documentLinkExtractor?: Pick<FeishuDocumentLinkExtractor, "extractLinks">;
  groupVisibleDocumentRegistrar?: Pick<GroupVisibleDocumentRegistrar, "registerDiscoveredLinks">;
  runtimeController?: RuntimeGate;
}) {
  return {
    async process(event: RawEvent): Promise<void> {
      const parsed = parseFeishuMessageEvent(event);
      if (parsed === undefined) {
        return;
      }
      if (
        runtimeController !== undefined &&
        !runtimeController.canProcessIncomingEvent({ groupId: parsed.chatId })
      ) {
        return;
      }

      await messages.upsertMessage(parsed);
      const links = extractDocumentLinks(parsed.text, documentLinkExtractor);
      if (links.length === 0 || groupVisibleDocumentRegistrar === undefined) {
        return;
      }

      await groupVisibleDocumentRegistrar.registerDiscoveredLinks({
        chatId: parsed.chatId,
        messageId: parsed.providerMessageId,
        senderId: parsed.senderId,
        observedAt: parsed.sentAt,
        links,
      });
    },
  };
}

function extractDocumentLinks(
  text: string | undefined,
  extractor: Pick<FeishuDocumentLinkExtractor, "extractLinks"> | undefined,
): FeishuDocumentLink[] {
  if (text === undefined || extractor === undefined) {
    return [];
  }

  return extractor.extractLinks(text);
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
  if (typeof content !== "string") {
    return undefined;
  }

  try {
    const parsed = JSON.parse(content) as unknown;
    if (messageType === "text") {
      if (!isRecord(parsed)) {
        return undefined;
      }

      return readOptionalString(parsed.text);
    }

    if (messageType === "post") {
      return readPostText(parsed);
    }

    return undefined;
  } catch {
    return undefined;
  }
}

function readPostText(value: unknown): string | undefined {
  const parts: string[] = [];
  collectPostTextParts(value, parts);

  const text = parts
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join(" ")
    .replace(/\s+/gu, " ")
    .trim();

  return text.length > 0 ? text : undefined;
}

const readablePostContentKeys = new Set(["title", "text", "href", "url"]);

function collectPostTextParts(value: unknown, parts: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectPostTextParts(item, parts);
    }
    return;
  }

  if (!isRecord(value)) {
    return;
  }

  for (const [key, nestedValue] of Object.entries(value)) {
    if (typeof nestedValue === "string" && readablePostContentKeys.has(key)) {
      parts.push(nestedValue);
      continue;
    }

    if (Array.isArray(nestedValue) || isRecord(nestedValue)) {
      collectPostTextParts(nestedValue, parts);
    }
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
