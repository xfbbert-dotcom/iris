import type { FeishuTenantAccessTokenProvider } from "./feishu-tenant-access-token-provider.js";
import { readPositiveSafeInteger } from "../config/numeric-guards.js";
import { readBoundedJsonResponse } from "../integrations/bounded-json-response.js";
import { readFeishuMessageText } from "./feishu-message-text.js";
import type { AssistantDocumentSourceBinding } from "../memory/context-assembly.js";
import type { SharedChatSourceBinding } from "../shared-chat/working-chat-scope.js";

export type FeishuChatHistoryMessage = {
  messageId: string;
  chatId: string;
  senderId: string;
  text: string;
  sentAt: Date;
  parentMessageId?: string;
  rootMessageId?: string;
  role?: "assistant";
  underlyingDocumentSources?: AssistantDocumentSourceBinding[];
  underlyingChatSources?: SharedChatSourceBinding[];
  sharedChatRecap?: boolean;
};

export type FeishuChatHistoryReader = {
  listRecentMessages(input: {
    chatId: string;
    limit: number;
    timeRange?: { start: Date; end: Date };
  }): Promise<FeishuChatHistoryMessage[]>;
  readMessagesByIds?(input: { chatId: string; messageIds: string[]; sender?: "assistant" }): Promise<FeishuChatHistoryMessage[]>;
};

export type FeishuChatHistoryReaderDependencies = {
  baseUrl: string;
  tokenProvider: FeishuTenantAccessTokenProvider;
  fetch?: typeof fetch;
  timeoutMs?: number;
  assistantAppId?: string;
};

export class FeishuChatHistoryError extends Error {
  readonly code = "history_unavailable";

  constructor() {
    super("Feishu chat history unavailable");
    this.name = "FeishuChatHistoryError";
  }
}

const DEFAULT_HISTORY_TIMEOUT_MS = 10_000;
const MAX_HISTORY_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_HISTORY_PAGE_ITEMS = 50;
const MAX_HISTORY_PAGES = 2;
const MAX_HISTORY_MESSAGES = 100;
const MAX_FEISHU_IDENTIFIER_CHARS = 512;
const MAX_HISTORY_TIME_RANGE_MS = 31 * 24 * 60 * 60 * 1000;
const MAX_MESSAGE_IDS = 8;
const MAX_MESSAGE_REQUEST_CONCURRENCY = 2;
const MAX_SINGLE_MESSAGE_RESPONSE_BYTES = 256 * 1024;

export function createFeishuChatHistoryReader({
  baseUrl,
  tokenProvider,
  fetch = globalThis.fetch,
  timeoutMs = DEFAULT_HISTORY_TIMEOUT_MS,
  assistantAppId,
}: FeishuChatHistoryReaderDependencies): FeishuChatHistoryReader {
  const safeTimeoutMs = readPositiveSafeInteger(timeoutMs, "Feishu chat history timeoutMs");

  return {
    async listRecentMessages(input) {
      const limit = Number.isFinite(input.limit)
        ? Math.max(0, Math.min(MAX_HISTORY_MESSAGES, Math.floor(input.limit)))
        : 0;
      if (limit === 0) return [];

      try {
        const chatId = readIdentifier(input.chatId);
        if (chatId === undefined) throw new FeishuChatHistoryError();
        const timeRange = readTimeRange(input.timeRange);
        const timeQuery = timeRange === undefined ? ""
          : `&start_time=${Math.floor(timeRange.startMs / 1000)}&end_time=${Math.ceil(timeRange.endMs / 1000)}`;

        const tenantAccessToken = await tokenProvider.getTenantAccessToken();
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), safeTimeoutMs);
        try {
          const messagesById = new Map<string, FeishuChatHistoryMessage>();
          const seenPageTokens = new Set<string>();
          let pageToken: string | undefined;
          for (let pageIndex = 0; pageIndex < MAX_HISTORY_PAGES; pageIndex += 1) {
            const cursorQuery = pageToken === undefined ? "" : `&page_token=${encodeURIComponent(pageToken)}`;
            const response = await fetch(
              `${baseUrl.replace(/\/+$/u, "")}/open-apis/im/v1/messages?container_id_type=chat&container_id=${encodeURIComponent(chatId)}&page_size=${MAX_HISTORY_PAGE_ITEMS}&sort_type=ByCreateTimeDesc${timeQuery}${cursorQuery}`,
              {
                method: "GET",
                headers: { authorization: `Bearer ${tenantAccessToken}` },
                signal: controller.signal,
              },
            );
            if (!response.ok) throw new FeishuChatHistoryError();
            const body = await readBoundedJsonResponse({
              response,
              invalidJsonErrorMessage: "Feishu chat history unavailable",
              maxResponseBytes: MAX_HISTORY_RESPONSE_BYTES,
              responseSizeErrorMessage: "Feishu chat history unavailable",
            });
            if (controller.signal.aborted) throw new FeishuChatHistoryError();
            const page = readHistoryPage(body);
            for (const item of page.items) {
              const message = readHistoryMessage(item, chatId);
              if (message === undefined) continue;
              if (timeRange !== undefined && (
                message.sentAt.getTime() < timeRange.startMs || message.sentAt.getTime() >= timeRange.endMs
              )) continue;
              const previous = messagesById.get(message.messageId);
              if (previous === undefined || previous.sentAt.getTime() < message.sentAt.getTime()) {
                messagesById.set(message.messageId, message);
              }
            }

            if (messagesById.size >= limit || !page.hasMore) break;
            const nextPageToken = readIdentifier(page.pageToken);
            if (nextPageToken === undefined || seenPageTokens.has(nextPageToken)) {
              throw new FeishuChatHistoryError();
            }
            seenPageTokens.add(nextPageToken);
            pageToken = nextPageToken;
          }

          return [...messagesById.values()]
            .sort((left, right) => right.sentAt.getTime() - left.sentAt.getTime())
            .slice(0, limit);
        } finally {
          clearTimeout(timeout);
        }
      } catch {
        throw new FeishuChatHistoryError();
      }
    },
    async readMessagesByIds(input) {
      try {
        const chatId = readIdentifier(input.chatId);
        if (chatId === undefined || !Array.isArray(input.messageIds)) throw new FeishuChatHistoryError();
        const ownAppId = input.sender === "assistant" ? readIdentifier(assistantAppId) : undefined;
        if (input.sender === "assistant" && ownAppId === undefined) return [];
        const messageIds = [...new Set(input.messageIds.slice(0, MAX_MESSAGE_IDS).flatMap((value) => {
          const id = readIdentifier(value);
          return id === undefined ? [] : [id];
        }))];
        if (messageIds.length === 0) return [];

        const tenantAccessToken = await tokenProvider.getTenantAccessToken();
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), safeTimeoutMs);
        try {
          const messages: FeishuChatHistoryMessage[] = [];
          for (let offset = 0; offset < messageIds.length; offset += MAX_MESSAGE_REQUEST_CONCURRENCY) {
            if (controller.signal.aborted) throw new FeishuChatHistoryError();
            const batch = await Promise.all(
              messageIds.slice(offset, offset + MAX_MESSAGE_REQUEST_CONCURRENCY).map(async (messageId) => {
                const response = await fetch(
                  `${baseUrl.replace(/\/+$/u, "")}/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`,
                  { method: "GET", headers: { authorization: `Bearer ${tenantAccessToken}` }, signal: controller.signal },
                );
                if ([401, 403, 404].includes(response.status)) {
                  await response.body?.cancel().catch(() => undefined);
                  return undefined;
                }
                if (!response.ok) throw new FeishuChatHistoryError();
                const body = await readBoundedJsonResponse({
                  response,
                  invalidJsonErrorMessage: "Feishu chat history unavailable",
                  maxResponseBytes: MAX_SINGLE_MESSAGE_RESPONSE_BYTES,
                  responseSizeErrorMessage: "Feishu chat history unavailable",
                });
                if (controller.signal.aborted) throw new FeishuChatHistoryError();
                return readSingleHistoryMessage(body, chatId, messageId, ownAppId);
              }),
            );
            if (controller.signal.aborted) throw new FeishuChatHistoryError();
            messages.push(...batch.flatMap((message) => message === undefined ? [] : [message]));
          }
          return messages.sort((left, right) => right.sentAt.getTime() - left.sentAt.getTime());
        } finally {
          clearTimeout(timeout);
          controller.abort();
        }
      } catch {
        throw new FeishuChatHistoryError();
      }
    },
  };
}

function readTimeRange(value: unknown): { startMs: number; endMs: number } | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || !(value.start instanceof Date) || !(value.end instanceof Date)) {
    throw new FeishuChatHistoryError();
  }
  const startMs = value.start.getTime();
  const endMs = value.end.getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs <= 0 ||
    startMs >= endMs || endMs - startMs > MAX_HISTORY_TIME_RANGE_MS) {
    throw new FeishuChatHistoryError();
  }
  return { startMs, endMs };
}

function readSingleHistoryMessage(body: unknown, chatId: string, messageId: string, ownAppId?: string): FeishuChatHistoryMessage | undefined {
  if (!isRecord(body) || body.code !== 0 || !isRecord(body.data) ||
    !Array.isArray(body.data.items) || body.data.items.length > 1) {
    throw new FeishuChatHistoryError();
  }
  if (body.data.items.length === 0) return undefined;
  const item = body.data.items[0];
  if (!isRecord(item) || item.message_id !== messageId) throw new FeishuChatHistoryError();
  return readHistoryMessage(item, chatId, ownAppId);
}

function readHistoryPage(body: unknown): { items: unknown[]; hasMore: boolean; pageToken: unknown } {
  if (
    !isRecord(body) || body.code !== 0 || !isRecord(body.data) ||
    !Array.isArray(body.data.items) || body.data.items.length > MAX_HISTORY_PAGE_ITEMS ||
    typeof body.data.has_more !== "boolean"
  ) {
    throw new FeishuChatHistoryError();
  }
  return { items: body.data.items, hasMore: body.data.has_more, pageToken: body.data.page_token };
}

function readHistoryMessage(value: unknown, chatId: string, ownAppId?: string): FeishuChatHistoryMessage | undefined {
  if (
    !isRecord(value) || value.chat_id !== chatId || value.deleted !== false ||
    !isRecord(value.sender) ||
    !isRecord(value.body) || typeof value.msg_type !== "string"
  ) return undefined;
  if (ownAppId === undefined ? value.sender.sender_type !== "user"
    : value.sender.sender_type !== "app" || value.sender.id !== ownAppId) return undefined;

  const messageId = readIdentifier(value.message_id);
  const senderId = readIdentifier(value.sender.id);
  const sentAt = readTimestamp(value.create_time);
  const text = readFeishuMessageText(value.msg_type, value.body.content);
  if (messageId === undefined || senderId === undefined || sentAt === undefined || text === undefined) {
    return undefined;
  }
  const parentMessageId = readIdentifier(value.parent_id);
  const rootMessageId = readIdentifier(value.root_id);
  return {
    messageId,
    chatId,
    senderId,
    text,
    sentAt,
    ...(ownAppId === undefined ? {} : { role: "assistant" as const }),
    ...(parentMessageId === undefined ? {} : { parentMessageId }),
    ...(rootMessageId === undefined ? {} : { rootMessageId }),
  };
}

function readIdentifier(value: unknown): string | undefined {
  if (
    typeof value !== "string" || value.length === 0 ||
    value.length > MAX_FEISHU_IDENTIFIER_CHARS || value !== value.trim()
  ) return undefined;
  return value;
}

function readTimestamp(value: unknown): Date | undefined {
  if (typeof value !== "string" || !/^\d+$/u.test(value)) return undefined;
  const millis = Number(value);
  if (!Number.isSafeInteger(millis) || millis <= 0) return undefined;
  const date = new Date(millis);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
