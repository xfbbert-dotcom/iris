import type {
  ConversationMessageRepository,
  UpsertConversationMessageInput,
} from "./conversation-message-repository.js";
import type { RawEvent } from "../events/raw-event-queue.js";
import type {
  FeishuMentionAnswerResponder,
  FeishuMessageMention,
} from "./feishu-mention-answer-responder.js";
import type {
  FeishuDocumentLink,
  FeishuDocumentLinkExtractor,
} from "../documents/feishu-document-link-extractor.js";
import type { GroupVisibleDocumentRegistrar } from "../documents/group-visible-document-registrar.js";

type RuntimeGate = {
  canProcessIncomingEvent(input: { groupId?: string }): boolean;
  canReadGroupContext(groupId: string): boolean;
  canReadDocuments(): boolean;
};
type ParsedFeishuMessageEvent = UpsertConversationMessageInput & {
  mentions: FeishuMessageMention[];
};

const MAX_FEISHU_IDENTIFIER_CHARS = 512;
const MAX_FEISHU_MESSAGE_CONTENT_CHARS = 64_000;
const MAX_FEISHU_MESSAGE_TEXT_CHARS = 8000;
const TRUNCATION_MARKER = " ... [truncated]";

export function createFeishuMessageEventProcessor({
  messages,
  documentLinkExtractor,
  groupVisibleDocumentRegistrar,
  mentionAnswerResponder,
  runtimeController,
}: {
  messages: Pick<ConversationMessageRepository, "upsertMessage">;
  documentLinkExtractor?: Pick<FeishuDocumentLinkExtractor, "extractLinks">;
  groupVisibleDocumentRegistrar?: Pick<GroupVisibleDocumentRegistrar, "registerDiscoveredLinks">;
  mentionAnswerResponder?: Pick<FeishuMentionAnswerResponder, "maybeRespond">;
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
      if (
        runtimeController !== undefined &&
        !runtimeController.canReadGroupContext(parsed.chatId)
      ) {
        await maybeRespondToMention(parsed, mentionAnswerResponder);
        return;
      }

      let mentionResponseError: unknown;
      try {
        await maybeRespondToMention(parsed, mentionAnswerResponder);
      } catch (error) {
        mentionResponseError = error;
      }

      const { mentions: _mentions, ...messageFact } = parsed;
      await messages.upsertMessage(messageFact);

      let documentDiscoveryError: unknown;
      if (runtimeController === undefined || runtimeController.canReadDocuments()) {
        try {
          const links = extractDocumentLinks(parsed.text, documentLinkExtractor);
          if (links.length > 0 && groupVisibleDocumentRegistrar !== undefined) {
            await groupVisibleDocumentRegistrar.registerDiscoveredLinks({
              chatId: parsed.chatId,
              messageId: parsed.providerMessageId,
              senderId: parsed.senderId,
              observedAt: parsed.sentAt,
              links,
            });
          }
        } catch (error) {
          documentDiscoveryError = error;
        }
      }

      if (mentionResponseError !== undefined) {
        throw mentionResponseError;
      }
      if (documentDiscoveryError !== undefined) {
        throw documentDiscoveryError;
      }
    },
  };
}

function maybeRespondToMention(
  parsed: ParsedFeishuMessageEvent,
  mentionAnswerResponder: Pick<FeishuMentionAnswerResponder, "maybeRespond"> | undefined,
): Promise<unknown> {
  return mentionAnswerResponder?.maybeRespond({
    messageId: parsed.providerMessageId,
    chatId: parsed.chatId,
    senderId: parsed.senderId,
    text: parsed.text,
    mentions: parsed.mentions,
  }) ?? Promise.resolve(undefined);
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

function parseFeishuMessageEvent(event: RawEvent): ParsedFeishuMessageEvent | undefined {
  if (event.provider !== "feishu" || !isRecord(event.rawBody)) {
    return undefined;
  }

  const header = event.rawBody.header;
  const headerEventType = isRecord(header) ? readString(header.event_type) : "";
  const eventType = headerEventType.length > 0 ? headerEventType : event.eventType;
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
    text: truncateMessageText(readText(messageType, message.content)),
    mentions: readMentions(message.mentions),
    sentAt: readFeishuTimestamp(
      message.create_time,
      readFeishuTimestamp(isRecord(header) ? header.create_time : undefined, event.receivedAt),
    ),
    rawEventIdempotencyKey: event.idempotencyKey,
  };
}

function readMentions(value: unknown): FeishuMessageMention[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((item): FeishuMessageMention[] => {
    if (!isRecord(item)) {
      return [];
    }

    const key = readOptionalIdentifier(item.key);
    if (key === undefined) {
      return [];
    }

    return [
      {
        key,
        ...(readMentionOpenId(item.id) === undefined
          ? {}
          : { openId: readMentionOpenId(item.id) }),
        ...(readOptionalIdentifier(item.name) === undefined
          ? {}
          : { name: readOptionalIdentifier(item.name) }),
      },
    ];
  });
}

function readMentionOpenId(id: unknown): string | undefined {
  if (!isRecord(id)) {
    return undefined;
  }

  return readOptionalIdentifier(id.open_id);
}

function readSenderId(sender: unknown): string | undefined {
  if (!isRecord(sender) || !isRecord(sender.sender_id)) {
    return undefined;
  }

  return (
    readOptionalIdentifier(sender.sender_id.open_id) ??
    readOptionalIdentifier(sender.sender_id.union_id) ??
    readOptionalIdentifier(sender.sender_id.user_id)
  );
}

function readText(messageType: string, content: unknown): string | undefined {
  if (typeof content !== "string" || content.length > MAX_FEISHU_MESSAGE_CONTENT_CHARS) {
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
const MAX_POST_TEXT_TRAVERSAL_DEPTH = 20;
const MAX_POST_TEXT_PARTS = 200;

function collectPostTextParts(value: unknown, parts: string[], depth = 0): void {
  if (depth > MAX_POST_TEXT_TRAVERSAL_DEPTH || parts.length >= MAX_POST_TEXT_PARTS) {
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      if (parts.length >= MAX_POST_TEXT_PARTS) {
        break;
      }
      collectPostTextParts(item, parts, depth + 1);
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
      collectPostTextParts(nestedValue, parts, depth + 1);
    }
  }
}

function readFeishuTimestamp(value: unknown, fallback: Date): Date {
  const parsed = readFeishuTimestampMillis(value);
  if (parsed === undefined) {
    return fallback;
  }

  const date = new Date(parsed);
  return Number.isNaN(date.getTime()) ? fallback : date;
}

function readFeishuTimestampMillis(value: unknown): number | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

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

function readString(value: unknown): string {
  return readOptionalIdentifier(value) ?? "";
}

function readOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function truncateMessageText(value: string | undefined): string | undefined {
  if (value === undefined || value.length <= MAX_FEISHU_MESSAGE_TEXT_CHARS) {
    return value;
  }

  const prefixChars = MAX_FEISHU_MESSAGE_TEXT_CHARS - TRUNCATION_MARKER.length;
  return `${value.slice(0, prefixChars).trimEnd()}${TRUNCATION_MARKER}`;
}

function readOptionalIdentifier(value: unknown): string | undefined {
  const trimmed = readOptionalString(value);
  if (trimmed === undefined || trimmed.length > MAX_FEISHU_IDENTIFIER_CHARS) {
    return undefined;
  }

  return trimmed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
